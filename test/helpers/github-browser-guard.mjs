import { AsyncResource } from "node:async_hooks";
import {
  blockGitHubTestCommand,
  githubTestHostPolicy,
  isGitHubTestHost,
  withGitHubNegativeControl,
} from "./github-network-guard.mjs";

const installed = Symbol.for("openclaw.test.githubChromiumGuard");
const browsers = new WeakSet();
const contexts = new WeakMap();
const controls = new WeakMap();

/** Each expected URL consumes one control in this dedicated browser context. */
export async function withGitHubBrowserNegativeControls(context, urls, action) {
  if (controls.has(context)) throw new Error("Browser controls already active for this context");
  const expected = new Map(
    urls.map((url) => [
      url,
      withGitHubNegativeControl(() =>
        AsyncResource.bind((transport) => blockGitHubTestCommand(transport)),
      ),
    ]),
  );
  controls.set(context, expected);
  try {
    return await action();
  } finally {
    controls.delete(context);
  }
}

function record(context, url, transport) {
  const expected = controls.get(context);
  const control = expected?.get(url);
  expected?.delete(url);
  try {
    if (control) control(transport);
    else blockGitHubTestCommand(transport);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("GitHub network access is forbidden")
    )
      throw error;
  }
}

function blockedHostPatterns() {
  const { suffixes, exact } = githubTestHostPolicy();
  const hosts = [...new Set([...suffixes.flatMap((host) => [host, `*.${host}`]), ...exact])];
  return hosts.flatMap((host) => [host, `${host}.`]);
}

function contextOptions(options = {}) {
  return {
    ...options,
    ...(options.proxy
      ? {
          proxy: {
            ...options.proxy,
            bypass: [...blockedHostPatterns(), options.proxy.bypass].filter(Boolean).join(","),
          },
        }
      : {}),
  };
}

function launchOptions(options = {}) {
  const args = options.args ?? [];
  if (
    args.some((arg) =>
      /^(?:--proxy(?:[-=]|$)|--host-rules(?:=|$)|--host-resolver-rules$)/u.test(arg),
    )
  ) {
    blockGitHubTestCommand("unresolved-browser-network-options");
  }
  const inherited = args
    .filter((arg) => arg.startsWith("--host-resolver-rules="))
    .map((arg) => arg.slice(22));
  // Chromium applies exclusions before every map, regardless of textual order.
  if (
    inherited.some((rules) => rules.split(",").some((rule) => /^\s*exclude(?:\s|$)/iu.test(rule)))
  ) {
    blockGitHubTestCommand("unresolved-browser-resolver-exclusion");
  }
  return {
    ...contextOptions(options),
    // Chromium redirects and service-worker requests can bypass Playwright routes.
    args: [
      ...args.filter((arg) => !arg.startsWith("--host-resolver-rules=")),
      ...(!options.proxy ? ["--no-proxy-server"] : []),
      `--host-resolver-rules=${[...blockedHostPatterns().map((host) => `MAP ${host} ~NOTFOUND`), ...inherited].join(",")}`,
    ],
  };
}

async function guardContext(context) {
  let ready = contexts.get(context);
  if (!ready) {
    ready = (async () => {
      const recorded = new WeakSet();
      const recordRequest = (request) => {
        if (isGitHubTestHost(new URL(request.url()).hostname) && !recorded.has(request)) {
          recorded.add(request);
          record(context, request.url(), "browser-http");
        }
      };
      // Fulfilled mock routes never dispatch, so only refused requests count.
      context.on("requestfailed", (request) => {
        if (request.failure()?.errorText === "net::ERR_NAME_NOT_RESOLVED") recordRequest(request);
      });
      await context.route(
        (url) => isGitHubTestHost(url.hostname),
        async (route) => {
          recordRequest(route.request());
          await route.abort("blockedbyclient");
        },
      );
      await context.routeWebSocket(
        (url) => isGitHubTestHost(url.hostname),
        async (socket) => {
          record(context, socket.url(), "browser-websocket");
          await socket.close({ code: 1008, reason: "GitHub access disabled in ordinary tests" });
        },
      );
    })();
    contexts.set(context, ready);
  }
  await ready;
  return context;
}

function guardBrowser(browser) {
  if (browsers.has(browser)) return browser;
  browsers.add(browser);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(contextOptions(options));
    try {
      return await guardContext(context);
    } catch (error) {
      await context.close();
      throw error;
    }
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await newPage(contextOptions(options));
    try {
      await guardContext(page.context());
      return page;
    } catch (error) {
      await page.context().close();
      throw error;
    }
  };
  return browser;
}

/** Public Playwright launch APIs are shared by Node UI tests and Vitest's provider. */
export function installGitHubChromiumGuard(chromium) {
  if (chromium[installed]) return;
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options) => guardBrowser(await launch(launchOptions(options)));
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (directory, options) => {
    // The caller must navigate after the context has its reporting routes. Resolver
    // blocking alone cannot attribute requests made by an initial app document.
    if (options?.args?.some((arg) => arg.startsWith("--app=") && arg !== "--app=about:blank")) {
      blockGitHubTestCommand("unresolved-browser-startup");
    }
    const context = await persistent(directory, launchOptions(options));
    try {
      await guardContext(context);
      guardBrowser(context.browser());
      return context;
    } catch (error) {
      await context.close();
      throw error;
    }
  };
  Object.defineProperty(chromium, installed, { value: true });
}
