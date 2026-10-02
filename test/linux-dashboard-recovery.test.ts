import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as yieldToDashboard } from "node:timers/promises";
import vm from "node:vm";
import { test } from "vitest";
import { createDeferred } from "./helpers/promise.js";

const dashboardSource = readFileSync(new URL("../apps/linux/ui/main.js", import.meta.url), "utf8");

function fakeElement() {
  const classes = new Set(["hidden"]);
  const listeners = new Map<string, () => unknown>();
  return {
    className: "",
    classList: {
      contains: (name: string) => classes.has(name),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
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

async function mountDashboard(search: string, openReleasePage = () => Promise.resolve()) {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const invoked: string[] = [];
  const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
  const document = {
    createElement: fakeElement,
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, fakeElement());
      }
      return elements.get(selector);
    },
  };
  const window = {
    __TAURI__: {
      core: {
        invoke(command: string) {
          invoked.push(command);
          if (command === "discover_gateways") {
            return Promise.resolve([]);
          }
          if (command === "open_release_page") {
            return openReleasePage();
          }
          return Promise.resolve({ phase: "connected" });
        },
      },
      event: {
        async listen(
          name: string,
          listener: (event: { payload: Record<string, unknown> }) => void,
        ) {
          listeners.set(name, listener);
          return () => {};
        },
      },
    },
    location: { search },
    setInterval() {},
  };

  await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
    document,
    URLSearchParams,
    window,
  });

  return {
    invoked,
    element: (selector: string) => {
      const element = elements.get(selector);
      assert.ok(element);
      return element;
    },
    emit: (name: string, payload: Record<string, unknown> = {}) => {
      const listener = listeners.get(name);
      assert.ok(listener);
      listener({ payload });
    },
  };
}

test("missing CLI mode offers installation without retrying bootstrap", async () => {
  const { element, invoked } = await mountDashboard("?mode=missingCli");

  assert.equal(element("#title").textContent, "OpenClaw needs the CLI");
  assert.equal(element("#install-controls").classList.contains("hidden"), false);
  assert.equal(invoked.includes("bootstrap"), false);
});

test("CLI recovery errors offer both retry and reinstall", async () => {
  const { element } = await mountDashboard("?mode=error");

  assert.equal(element("#primary-action").textContent, "Try again");
  assert.equal(element("#action-controls").classList.contains("hidden"), false);
  assert.equal(element("#install-controls").classList.contains("hidden"), false);
});

test.each([
  {
    event: "updater://available",
    message: "Downloading in the background…",
  },
  {
    event: "updater://available-manual",
    message: "Install the latest system package from the release page.",
  },
])("$event keeps release markup out of the status banner", async ({ event, message }) => {
  const { element, emit } = await mountDashboard("?mode=missingCli");
  emit(event, {
    version: "2026.9.10",
    notes: "<!-- openclaw-release-publication:docs-v1 -->\n## Changes\n\n- A release fix.",
  });

  assert.equal(element("#update-message").textContent, message);
});

test("failed release-page opening retains a retry that clears the error on success", async () => {
  const opening = createDeferred();
  const retry = createDeferred();
  let attempts = 0;
  const { element, emit, invoked } = await mountDashboard("?mode=missingCli", () =>
    ++attempts === 1 ? opening.promise : retry.promise,
  );
  emit("updater://available-manual", { version: "2026.9.10" });
  assert.equal(element("#update-action").textContent, "Open download page");
  element("#update-action").click();
  opening.reject(new Error("Browser unavailable"));
  await opening.promise.catch(() => {});
  // Let the VM's cross-realm promise continuation finish rendering.
  await yieldToDashboard();

  assert.equal(element("#update-title").textContent, "Could not open release page");
  assert.equal(element("#update-message").textContent, "Browser unavailable");
  assert.equal(element("#update-action").classList.contains("hidden"), false);
  assert.equal(element("#update-action").textContent, "Open download page");
  assert.equal(attempts, 1);
  element("#update-action").click();
  assert.equal(attempts, 2);
  retry.resolve();
  await retry.promise;
  await yieldToDashboard();
  assert.equal(element("#update-title").textContent, "Update available v2026.9.10");
  assert.equal(
    element("#update-message").textContent,
    "Install the latest system package from the release page.",
  );
  assert.equal(element("#update-banner").classList.contains("hidden"), false);
  assert.equal(invoked.filter((command) => command === "open_release_page").length, 2);
});

test.each(["success", "failure"])(
  "late release-page %s preserves a newer update action",
  async (outcome) => {
    const opening = createDeferred();
    const { element, emit, invoked } = await mountDashboard(
      "?mode=missingCli",
      () => opening.promise,
    );
    emit("updater://available-manual", { version: "2026.9.10" });
    element("#update-action").click();
    emit("updater://ready", { version: "2026.9.11" });
    if (outcome === "failure") {
      opening.reject(new Error("Browser unavailable"));
    } else {
      opening.resolve();
    }
    await opening.promise.catch(() => {});
    await yieldToDashboard();

    assert.equal(element("#update-title").textContent, "Update ready");
    assert.equal(element("#update-action").textContent, "Restart to update");
    assert.equal(element("#update-action").classList.contains("hidden"), false);
    element("#update-action").click();
    assert.equal(invoked.at(-1), "relaunch");
  },
);

test.each(["success", "failure"])(
  "late release-page %s does not reopen a dismissed update banner",
  async (outcome) => {
    const opening = createDeferred();
    const { element, emit } = await mountDashboard("?mode=missingCli", () => opening.promise);
    emit("updater://available-manual", { version: "2026.9.10" });
    element("#update-action").click();
    element("#update-dismiss").click();
    assert.equal(element("#update-banner").classList.contains("hidden"), true);
    if (outcome === "failure") {
      opening.reject(new Error("Browser unavailable"));
    } else {
      opening.resolve();
    }
    await opening.promise.catch(() => {});
    await yieldToDashboard();

    assert.equal(element("#update-banner").classList.contains("hidden"), true);
    assert.equal(element("#update-title").textContent, "Update available v2026.9.10");
  },
);

test.each([
  { name: "local", remote: null, failure: false, entry: "settings", lateRetry: false },
  {
    name: "remote",
    remote: { transport: "direct", url: "https://gateway.example.com" },
    failure: false,
    entry: "settings",
    lateRetry: false,
  },
  { name: "failed return", remote: null, failure: true, entry: "settings", lateRetry: false },
  { name: "startup error Edit", remote: null, failure: false, entry: "startup", lateRetry: false },
  {
    name: "late retry after Edit",
    remote: null,
    failure: false,
    entry: "startup",
    lateRetry: true,
  },
  { name: "recovery return", remote: null, failure: false, entry: "recovery", lateRetry: false },
])(
  "Connection Settings preserves a native Back action for $name",
  async ({ remote, failure, entry, lateRetry }) => {
    const elements = new Map<string, ReturnType<typeof fakeElement>>();
    const invoked: Array<{ command: string; args: unknown }> = [];
    const retry = createDeferred<{ phase: string }>();
    const document = {
      createElement: fakeElement,
      querySelector(selector: string) {
        if (!elements.has(selector)) {
          elements.set(selector, fakeElement());
        }
        return elements.get(selector);
      },
    };
    const window = {
      __TAURI__: {
        core: {
          async invoke(
            command: string,
            args?: { connectionSettings?: boolean; remoteRetry?: boolean },
          ) {
            invoked.push({ command, args });
            if (command === "bootstrap") {
              if (args?.remoteRetry) {
                return retry.promise;
              }
              return args?.connectionSettings ? { remote } : { phase: "remoteError" };
            }
            if (command === "close_connection_settings" && failure) {
              throw new Error("The previous dashboard is unavailable. Try again.");
            }
            return [];
          },
        },
        event: { listen: async () => () => {} },
      },
      location: {
        search:
          entry === "settings"
            ? "?mode=connectionSettings"
            : entry === "recovery"
              ? "?mode=remoteError"
              : "",
      },
      setInterval() {},
    };

    await vm.runInNewContext(`(async () => { ${dashboardSource}\n})()`, {
      document,
      URLSearchParams,
      window,
    });

    if (entry !== "settings") {
      assert.equal(elements.get("#title")?.textContent, "Connection needs attention");
      if (entry === "recovery") {
        assert.equal(
          invoked.some(({ command }) => command === "bootstrap"),
          false,
        );
      }
      if (lateRetry) {
        elements.get("#primary-action")?.click();
      }
      elements.get("#edit-connection")?.click();
      // Drain the actual click's promise continuations, without changing the handler.
      await yieldToDashboard();
      if (lateRetry) {
        retry.resolve({ phase: "remoteError" });
        await yieldToDashboard();
      }
      assert.equal(elements.get("#title")?.textContent, "Connection Settings");
    }
    assert.equal(elements.get(".setup-navigation")?.classList.contains("hidden"), false);
    assert.equal(elements.get("#setup-continue")?.classList.contains("hidden"), true);
    assert.equal(elements.get("#setup-back")?.disabled, false);
    const beforeBack = invoked.length;
    await elements.get("#setup-back")?.click();
    assert.deepEqual(invoked.slice(beforeBack), [
      { command: "close_connection_settings", args: undefined },
    ]);
    assert.equal(elements.get("#setup-back")?.disabled, false);
    if (failure) {
      assert.equal(elements.get("#title")?.textContent, "Connection Settings");
      assert.equal(elements.get(".setup-navigation")?.classList.contains("hidden"), false);
      assert.match(
        elements.get("#remote-feedback")?.textContent ?? "",
        /previous dashboard is unavailable/,
      );
    }
  },
);

test.each(
  [
    { platform: "freebsd", externalService: true },
    { platform: "linux", externalService: false },
    { platform: "macos", externalService: false },
    { platform: "windows", externalService: false },
  ].flatMap((entry) =>
    [true, false].map((releaseBuild) => Object.assign({}, entry, { releaseBuild })),
  ),
)(
  "$platform first-run describes its local service ownership (release: $releaseBuild)",
  async ({ platform, externalService, releaseBuild }) => {
    for (const phase of ["unconfigured", "missingCli"]) {
      const installFailure = "Fixture: start the Gateway with openclaw gateway run, then retry.";
      const elements = new Map<string, ReturnType<typeof fakeElement>>();
      const invoked: { command: string; args?: Record<string, unknown> }[] = [];
      const document = {
        createElement: fakeElement,
        querySelector(selector: string) {
          if (!elements.has(selector)) {
            elements.set(selector, fakeElement());
          }
          return elements.get(selector);
        },
      };
      const window = {
        __TAURI__: {
          core: {
            async invoke(command: string, args?: Record<string, unknown>) {
              invoked.push({ command, args });
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
            },
          },
          event: { listen: async () => () => {} },
        },
        location: { search: "" },
        setInterval() {},
      };
      const actions = await vm.runInNewContext(
        `(async () => { ${dashboardSource}\nreturn { renderConnectionChoices, continueLocalSetup, install }; })()`,
        { document, URLSearchParams, window },
      );
      actions.renderConnectionChoices();
      const description = elements.get("#description")?.textContent ?? "";
      const subtitle = elements.get("#local-subtitle")?.textContent ?? "";
      if (externalService) {
        assert.match(description, /openclaw package service/);
        assert.match(description, /openclaw gateway run/);
        assert.match(description, /same account you used for onboarding/);
        assert.match(subtitle, /Gateway you start/);
        assert.doesNotMatch(
          `${description} ${subtitle}`,
          /starts automatically|installs everything/,
        );
      } else {
        assert.equal(
          description,
          "Most people choose this computer. OpenClaw installs everything and keeps your assistant running in the background.",
        );
        assert.equal(subtitle, "Private to this computer. Installs and starts automatically.");
      }

      await actions.continueLocalSetup();
      assert.equal(
        elements.get("#install-hint")?.textContent,
        externalService
          ? "Installs the CLI in ~/.openclaw using your system Node.js and npm."
          : "Installs the CLI and managed Node runtime in ~/.openclaw.",
      );
      if (phase === "unconfigured") {
        assert.deepEqual(
          invoked
            .filter(({ command }) => command === "bootstrap")
            .map(({ args }) => args && Object.assign({}, args)),
          [undefined, { explicitLocal: true }],
        );
        assert.equal(
          elements.get("#activity-label")?.textContent,
          externalService ? "Connecting to your local Gateway…" : "Starting your local Gateway…",
        );
      } else if (!releaseBuild) {
        assert.equal(elements.get("#title")?.textContent, "Choose a release channel");
        if (externalService) {
          assert.match(elements.get("#description")?.textContent ?? "", /system Node.js and npm/);
        }
        assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
        assert.equal(
          invoked.some(({ command }) => command === "install_cli"),
          false,
        );
        await actions.install();
      }
      if (phase === "missingCli") {
        assert.equal(elements.get("#title")?.textContent, "OpenClaw needs attention");
        assert.equal(elements.get("#description")?.textContent, installFailure);
        assert.equal(elements.get("#log-status")?.textContent, "FAILED");
        assert.equal(elements.get("#install-controls")?.classList.contains("hidden"), false);
        assert.equal(elements.get("#install-button")?.disabled, false);
      }
      assert.equal(
        invoked.filter(({ command }) => command === "install_cli").length,
        phase === "missingCli" ? 1 : 0,
      );
      assert.equal(
        invoked.some(({ command }) => command === "gateway_action"),
        false,
      );
    }
  },
);
