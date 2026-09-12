import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "vitest";
import { createDeferred } from "./helpers/promise.js";

const dashboardSource = readFileSync(new URL("../apps/linux/ui/main.js", import.meta.url), "utf8");

function fakeElement() {
  const classes = new Set(["hidden"]);
  const listeners = new Map<string, () => void>();
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
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, listener);
    },
    click() {
      const listener = listeners.get("click");
      assert.ok(listener);
      listener();
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

test("failed release-page opening retains an explicit download-page retry", async () => {
  const opening = createDeferred();
  let attempts = 0;
  const { element, emit, invoked } = await mountDashboard("?mode=missingCli", () =>
    ++attempts === 1 ? opening.promise : Promise.resolve(),
  );
  emit("updater://available-manual", { version: "2026.9.10" });
  assert.equal(element("#update-action").textContent, "Open download page");
  element("#update-action").click();
  opening.reject(new Error("Browser unavailable"));
  await opening.promise.catch(() => {});

  assert.equal(element("#update-title").textContent, "Could not open release page");
  assert.equal(element("#update-message").textContent, "Browser unavailable");
  assert.equal(element("#update-action").classList.contains("hidden"), false);
  assert.equal(element("#update-action").textContent, "Open download page");
  assert.equal(attempts, 1);
  element("#update-action").click();
  assert.equal(attempts, 2);
  assert.equal(invoked.filter((command) => command === "open_release_page").length, 2);
});

test("late release-page failure preserves a newer update action", async () => {
  const opening = createDeferred();
  const { element, emit, invoked } = await mountDashboard(
    "?mode=missingCli",
    () => opening.promise,
  );
  emit("updater://available-manual", { version: "2026.9.10" });
  element("#update-action").click();
  emit("updater://ready", { version: "2026.9.11" });
  opening.reject(new Error("Browser unavailable"));
  await opening.promise.catch(() => {});

  assert.equal(element("#update-title").textContent, "Update ready");
  assert.equal(element("#update-action").textContent, "Restart to update");
  assert.equal(element("#update-action").classList.contains("hidden"), false);
  element("#update-action").click();
  assert.equal(invoked.at(-1), "relaunch");
});

test("late release-page failure does not reopen a dismissed update banner", async () => {
  const opening = createDeferred();
  const { element, emit } = await mountDashboard("?mode=missingCli", () => opening.promise);
  emit("updater://available-manual", { version: "2026.9.10" });
  element("#update-action").click();
  element("#update-dismiss").click();
  assert.equal(element("#update-banner").classList.contains("hidden"), true);
  opening.reject(new Error("Browser unavailable"));
  await opening.promise.catch(() => {});

  assert.equal(element("#update-banner").classList.contains("hidden"), true);
  assert.equal(element("#update-title").textContent, "Update available v2026.9.10");
});
