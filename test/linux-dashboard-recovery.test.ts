import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as yieldToDashboard } from "node:timers/promises";
import vm from "node:vm";
import { test } from "vitest";
import { createDeferred } from "./helpers/promise.js";

const dashboardSource = readFileSync(new URL("../apps/linux/ui/main.js", import.meta.url), "utf8");
const manualUpdateMessage = "Install the latest system package from the release page.";
type Payload = Record<string, unknown>;
// Let cross-realm promise continuations finish rendering after settlement.
const settle = (pending: Promise<unknown>) => pending.then(yieldToDashboard);

function fakeElement() {
  const classes = new Set(["hidden"]);
  const listeners = new Map<string, () => unknown>();
  return {
    className: "",
    classList: {
      contains: (name: string) => classes.has(name),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        classes[enabled ? "add" : "delete"](name);
      },
    },
    disabled: false,
    textContent: "",
    value: "stable",
    addEventListener(event: string, listener: () => unknown) {
      listeners.set(event, listener);
    },
    click() {
      const listener = listeners.get("click");
      assert.ok(listener);
      return listener();
    },
    append() {},
    removeAttribute() {},
    replaceChildren() {},
    setAttribute() {},
  };
}

async function mountDashboard(
  search: string,
  openReleasePage = () => Promise.resolve(),
  bootstrap = { phase: "connected", setupError: undefined as string | undefined },
  invokeOverride?: (command: string, args?: Payload) => unknown,
) {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const calls: Array<{ command: string; args?: Payload }> = [];
  const listeners = new Map<string, (event: { payload: Payload }) => void>();
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      return elements.get(selector) ?? elements.set(selector, fakeElement()).get(selector);
    },
  };
  function invoke(command: string, args?: Payload) {
    calls.push({ command, args });
    if (invokeOverride) {
      return invokeOverride(command, args);
    }
    if (command === "open_release_page") {
      return openReleasePage();
    }
    const snapshot = command === "bootstrap" ? bootstrap : { phase: "connected" };
    return Promise.resolve(command === "discover_gateways" ? [] : snapshot);
  }
  async function listen(name: string, listener: (event: { payload: Payload }) => void) {
    listeners.set(name, listener);
    return () => {};
  }
  const window = {
    __TAURI__: { core: { invoke }, event: { listen } },
    location: { search },
    setInterval() {},
  };

  const actions = await vm.runInNewContext(
    `(async () => { ${dashboardSource}\nreturn { renderConnectionChoices, continueLocalSetup, install }; })()`,
    { document, URLSearchParams, window },
  );

  const element = (selector: string) => {
    const found = elements.get(selector);
    assert.ok(found, selector);
    return found;
  };
  return {
    calls,
    actions,
    element,
    text: (selector: string) => element(selector).textContent,
    hidden: (selector: string) => element(selector).classList.contains("hidden"),
    click: (selector: string) => element(selector).click(),
    called: (command: string) => calls.some((call) => call.command === command),
    callsFor: (command: string) => calls.filter((call) => call.command === command),
    emit: (name: string, payload: Payload = {}) => {
      const listener = listeners.get(name);
      assert.ok(listener);
      listener({ payload });
    },
  };
}

test("automatic setup failure returns to Gateway choices with the native error", async () => {
  const setupError = "Bundled runtime could not be installed.";
  const h = await mountDashboard("", undefined, { phase: "missingCli", setupError });
  assert.equal(h.text("#title"), "Where should your assistant live?");
  assert.equal(h.text("#description"), setupError);
  assert.equal(h.hidden("#connection-choices"), false);
  assert.equal(h.hidden("#welcome-screen"), true);
  assert.equal(h.called("install_cli"), false);
  assert.equal(h.called("connect_remote_gateway"), false);
});

test("missing CLI mode offers installation without retrying bootstrap", async () => {
  const h = await mountDashboard("?mode=missingCli");

  assert.equal(h.text("#title"), "OpenClaw needs the CLI");
  assert.equal(h.hidden("#install-controls"), false);
  assert.equal(h.called("bootstrap"), false);
});

test("CLI recovery errors offer both retry and reinstall", async () => {
  const h = await mountDashboard("?mode=error");

  assert.equal(h.text("#primary-action"), "Try again");
  assert.equal(h.hidden("#action-controls"), false);
  assert.equal(h.hidden("#install-controls"), false);
});

test.each([
  ["updater://available", "Downloading in the background…"],
  ["updater://available-manual", manualUpdateMessage],
])("%s keeps release markup out of the status banner", async (event, message) => {
  const h = await mountDashboard("?mode=missingCli");
  h.emit(event, {
    version: "2026.9.10",
    notes: "<!-- openclaw-release-publication:docs-v1 -->\n## Changes\n\n- A release fix.",
  });

  assert.equal(h.text("#update-message"), message);
});

test("failed release-page opening retains a retry that clears the error on success", async () => {
  const opening = createDeferred();
  const retry = createDeferred();
  let attempts = 0;
  const h = await mountDashboard("?mode=missingCli", () =>
    ++attempts === 1 ? opening.promise : retry.promise,
  );
  h.emit("updater://available-manual", { version: "2026.9.10" });
  assert.equal(h.text("#update-action"), "Open download page");
  h.click("#update-action");
  opening.reject(new Error("Browser unavailable"));
  await settle(opening.promise.catch(() => {}));

  assert.equal(h.text("#update-title"), "Could not open release page");
  assert.equal(h.text("#update-message"), "Browser unavailable");
  assert.equal(h.hidden("#update-action"), false);
  assert.equal(h.text("#update-action"), "Open download page");
  assert.equal(attempts, 1);
  h.click("#update-action");
  assert.equal(attempts, 2);
  retry.resolve();
  await settle(retry.promise);
  assert.equal(h.text("#update-title"), "Update available v2026.9.10");
  assert.equal(h.text("#update-message"), manualUpdateMessage);
  assert.equal(h.hidden("#update-banner"), false);
  assert.equal(h.callsFor("open_release_page").length, 2);
});

test.each(
  ["success", "failure"].flatMap((outcome) =>
    ["ready", "dismissed"].map((action) => ({ outcome, action })),
  ),
)("late release-page $outcome preserves the newer $action intent", async ({ outcome, action }) => {
  const opening = createDeferred();
  const h = await mountDashboard("?mode=missingCli", () => opening.promise);
  h.emit("updater://available-manual", { version: "2026.9.10" });
  h.click("#update-action");
  if (action === "ready") {
    h.emit("updater://ready", { version: "2026.9.11" });
  } else {
    h.click("#update-dismiss");
    assert.equal(h.hidden("#update-banner"), true);
  }
  if (outcome === "failure") {
    opening.reject(new Error("Browser unavailable"));
  } else {
    opening.resolve();
  }
  await settle(opening.promise.catch(() => {}));
  if (action === "ready") {
    assert.equal(h.text("#update-title"), "Update ready");
    assert.equal(h.text("#update-action"), "Restart to update");
    assert.equal(h.hidden("#update-action"), false);
    h.click("#update-action");
    assert.equal(h.calls.at(-1)?.command, "relaunch");
  } else {
    assert.equal(h.hidden("#update-banner"), true);
    assert.equal(h.text("#update-title"), "Update available v2026.9.10");
  }
});

test.each([
  {
    name: "remote",
    remote: { transport: "direct", url: "https://gateway.example.com" },
  },
  { name: "failed return", failure: true },
  { name: "late retry after Edit", mode: "", lateRetry: true },
  { name: "recovery return", mode: "remoteError" },
])(
  "Connection Settings preserves a native Back action for $name",
  async ({ remote = null, failure = false, mode = "connectionSettings", lateRetry = false }) => {
    const retry = createDeferred<{ phase: string }>();
    const h = await mountDashboard(
      mode ? `?mode=${mode}` : "",
      undefined,
      undefined,
      async (command, args) => {
        if (command === "bootstrap") {
          return args?.remoteRetry
            ? retry.promise
            : args?.connectionSettings
              ? { remote }
              : { phase: "remoteError" };
        }
        if (command === "close_connection_settings" && failure) {
          throw new Error("The previous dashboard is unavailable. Try again.");
        }
        return [];
      },
    );

    if (mode !== "connectionSettings") {
      assert.equal(h.text("#title"), "Connection needs attention");
      if (mode === "remoteError") {
        assert.equal(h.called("bootstrap"), false);
      }
      if (lateRetry) {
        h.click("#primary-action");
      }
      h.click("#edit-connection");
      // Drain the actual click's promise continuations, without changing the handler.
      await yieldToDashboard();
      if (lateRetry) {
        retry.resolve({ phase: "remoteError" });
        await yieldToDashboard();
      }
      assert.equal(h.text("#title"), "Connection Settings");
    }
    assert.equal(h.hidden(".setup-navigation"), false);
    assert.equal(h.hidden("#setup-continue"), true);
    assert.equal(h.element("#setup-back").disabled, false);
    const beforeBack = h.calls.length;
    await h.click("#setup-back");
    assert.deepEqual(h.calls.slice(beforeBack), [
      { command: "close_connection_settings", args: undefined },
    ]);
    assert.equal(h.element("#setup-back").disabled, false);
    if (failure) {
      assert.equal(h.text("#title"), "Connection Settings");
      assert.equal(h.hidden(".setup-navigation"), false);
      assert.match(h.text("#remote-feedback") ?? "", /previous dashboard is unavailable/);
    }
  },
);

test.each([
  ["freebsd", "unconfigured", true],
  ["linux", "unconfigured", true],
  ["freebsd", "missingCli", true],
  ["linux", "missingCli", true],
  ["freebsd", "missingCli", false],
  ["linux", "missingCli", false],
] as const)(
  "%s %s describes service ownership (release: %s)",
  async (platform, phase, releaseBuild) => {
    const externalService = platform === "freebsd";
    const installFailure = "Fixture: start the Gateway with openclaw gateway run, then retry.";
    const h = await mountDashboard("", undefined, undefined, async (command) => {
      if (command === "discover_gateways") {
        return [];
      }
      if (command === "build_info") {
        return { platform, releaseBuild };
      }
      if (command === "install_cli") {
        throw new Error(installFailure);
      }
      return { phase };
    });
    h.actions.renderConnectionChoices();
    const description = h.text("#description") ?? "";
    const subtitle = h.text("#local-subtitle") ?? "";
    if (externalService) {
      assert.match(description, /openclaw package service/);
      assert.match(description, /openclaw gateway run/);
      assert.match(description, /same account you used for onboarding/);
      assert.match(subtitle, /Gateway you start/);
      assert.doesNotMatch(`${description} ${subtitle}`, /starts automatically|installs everything/);
    } else {
      assert.equal(
        description,
        "Most people choose this computer. OpenClaw installs everything and keeps your assistant running in the background.",
      );
      assert.equal(subtitle, "Private to this computer. Installs and starts automatically.");
    }

    await h.actions.continueLocalSetup();
    assert.equal(
      h.text("#install-hint"),
      externalService
        ? "Installs the CLI in ~/.openclaw using your system Node.js and npm."
        : "Installs OpenClaw and its managed runtime in ~/.openclaw.",
    );
    if (phase === "unconfigured") {
      assert.deepEqual(
        h.callsFor("bootstrap").map(({ args }) => args && Object.assign({}, args)),
        [undefined, { explicitLocal: true }],
      );
      assert.equal(
        h.text("#activity-label"),
        externalService ? "Connecting to your local Gateway…" : "Starting your local Gateway…",
      );
    } else if (!releaseBuild) {
      assert.equal(h.text("#title"), "Choose a release channel");
      if (externalService) {
        assert.match(h.text("#description") ?? "", /system Node.js and npm/);
      }
      assert.equal(h.hidden("#install-controls"), false);
      assert.equal(h.called("install_cli"), false);
      await h.actions.install();
    }
    if (phase === "missingCli") {
      assert.equal(h.text("#title"), "OpenClaw needs attention");
      assert.equal(h.text("#description"), installFailure);
      assert.equal(h.text("#log-status"), "FAILED");
      assert.equal(h.hidden("#install-controls"), false);
      assert.equal(h.element("#install-button").disabled, false);
    }
    assert.equal(h.callsFor("install_cli").length, phase === "missingCli" ? 1 : 0);
    assert.equal(h.called("gateway_action"), false);
  },
);
