import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { serveCompanion } from "./native-desktop.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop Gateways E2E" });
const companionFile = (file: string) =>
  readFileSync(new URL(`../../../apps/linux/ui/${file}`, import.meta.url), "utf8");
const snapshot: NativeGatewaysSnapshot = {
  currentId: "primary",
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
  ],
};
type GatewayRequest = {
  command: string;
  params: { message: { type: string; id?: string }; token: string };
};

async function installAdapter(page: Page, config?: { origin?: string; base?: string }) {
  await page.addInitScript({
    content: `window.gatewayRequests = [];
      window.__TAURI_INTERNALS__ = { invoke: async (command, params) => {
        window.gatewayRequests.push({ command, params });
        if (window.holdNextGatewayRequest) {
          window.holdNextGatewayRequest = false;
          await new Promise((resolve) => { window.completeGatewayRequest = resolve; });
        }
        if (params.message.type === "open-settings") throw new Error("Could not open Gateway settings. Try again.");
      }};
      ${companionFile("gateway-notice.js")}
      (${companionFile("gateway-switch.js")})(${JSON.stringify({ origin: new URL(suite.server.baseUrl).origin, base: "", snapshot, ...config })});`,
  });
  return () => page.evaluate(() => Reflect.get(window, "gatewayRequests") as GatewayRequest[]);
}

async function ready(page: Page, documentToken: string, currentId = "primary") {
  await page.evaluate(
    ({ token, next }) => {
      window.dispatchEvent(
        new CustomEvent("openclaw:gateway-ready", { detail: { token, snapshot: next } }),
      );
    },
    { token: documentToken, next: { ...snapshot, currentId } },
  );
}

async function capture(page: Page, directory: string | undefined, name: string) {
  if (directory) {
    await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
  }
}

suite.define(() => {
  it.each(["index.html?mode=stopped", "gateways.html"])(
    "keeps one dismissible native Gateway notice on %s without modal alerts",
    async (file) => {
      await suite.withPage({}, async ({ page }) => {
        const dialogs: string[] = [];
        page.on("dialog", async (dialog) => {
          dialogs.push(dialog.message());
          await dialog.dismiss();
        });
        await serveCompanion(page);
        await page.addInitScript(() => {
          let holdProfiles = false;
          let releaseProfiles: (() => void) | undefined;
          Object.assign(window, {
            holdProfileRefresh: () => {
              holdProfiles = true;
            },
            releaseProfileRefresh: () => releaseProfiles?.(),
            __TAURI__: {
              core: {
                invoke: async (command: string) => {
                  if (command === "discover_gateways") {
                    return [];
                  }
                  if (command === "gateway_profile_request") {
                    if (holdProfiles) {
                      await new Promise<void>((resolve) => {
                        releaseProfiles = resolve;
                      });
                      holdProfiles = false;
                    }
                    return { profiles: [], selectedId: null };
                  }
                  return null;
                },
              },
              event: { listen: async () => () => {} },
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}companion/${file}`);
        const show = (message: string) =>
          page.evaluate((noticeMessage) => {
            window.dispatchEvent(
              new CustomEvent("openclaw:gateway-notice", { detail: { message: noticeMessage } }),
            );
          }, message);
        await show("Credential store is locked.");
        const notice = page.getByRole("alert").filter({ hasText: "Credential store is locked." });
        await notice.waitFor();
        const original = await notice.elementHandle();
        await page.addScriptTag({ content: companionFile("gateway-notice.js") });
        const repeated = "Credential store is locked. <img src=x onerror=alert('unsafe')>";
        await show(repeated);
        await show(repeated);
        expect(await original?.textContent()).toContain(repeated);
        expect(await page.getByRole("alert").count()).toBe(1);
        expect(await page.getByRole("alert").locator("img").count()).toBe(0);
        if (file === "gateways.html") {
          await page.evaluate(() => {
            Reflect.get(window, "holdProfileRefresh")();
            window.dispatchEvent(
              new CustomEvent("openclaw:gateway-profiles-changed", { detail: {} }),
            );
          });
          await expect
            .poll(() => page.getByRole("button", { name: "Add Gateway", exact: true }).isDisabled())
            .toBe(true);
        }
        await page.getByRole("button", { name: "Dismiss Gateway notice" }).click();
        expect(await page.getByRole("alert").count()).toBe(0);
        if (file === "gateways.html") {
          await page.evaluate(() => Reflect.get(window, "releaseProfileRefresh")());
        }
        await show("Retry after unlocking the credential store.");
        expect(await original?.textContent()).toContain("Retry after unlocking");
        expect(await page.getByRole("alert").count()).toBe(1);
        await page.evaluate(() => window.dispatchEvent(new Event("openclaw:gateway-notice-clear")));
        expect(await page.getByRole("alert").count()).toBe(0);
        expect(dialogs).toEqual([]);
      });
    },
  );

  it("uses the shared Gateway menu, queues until native readiness, and replaces the document token", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const parent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
      const proof = parent
        ? createControlUiE2eArtifactDir("desktop-gateway-switch", parent)
        : undefined;
      await installMockGateway(page);
      await page.goto(suite.server.baseUrl);
      const openMenu = async () => {
        await page.locator(".sidebar-identity-card").click();
        await page.locator(".sidebar-identity-menu").waitFor();
      };
      await openMenu();
      expect(await page.getByRole("menuitemradio", { name: /Studio/ }).count()).toBe(0);
      await capture(page, proof, "gateway-menu-before.png");
      const requests = await installAdapter(page);
      await page.addInitScript({
        content: `${companionFile("gateway-notice.js")}
          window.dispatchEvent(new CustomEvent("openclaw:gateway-notice", {
            detail: { message: "Credential store was unavailable during startup." },
          }));`,
      });
      await page.reload();
      await page.getByRole("alert").filter({ hasText: "unavailable during startup" }).waitFor();
      await openMenu();
      const studio = page.getByRole("menuitemradio", { name: /Studio/ });
      await studio.waitFor();
      await capture(page, proof, "gateway-menu-after.png");
      await studio.click();
      expect(await requests()).toEqual([]);
      await ready(page, "first-document");
      await expect.poll(requests).toEqual([
        {
          command: "gateway_request",
          params: { message: { type: "select", id: "profile:studio" }, token: "first-document" },
        },
      ]);
      await ready(page, "next-document", "profile:studio");
      await openMenu();
      await expect.poll(() => studio.getAttribute("aria-checked")).toBe("true");
      await page
        .getByRole("menuitemradio", { name: /Local Gateway/ })
        .click({ modifiers: ["Control"] });
      await openMenu();
      await page.locator('wa-dropdown-item[value="command:gateway-set-primary"]').click();
      await openMenu();
      await page.locator('wa-dropdown-item[value="command:gateway-settings"]').click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Could not open Gateway settings" })
        .waitFor();
      const notice = await page.getByRole("alert").elementHandle();
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-notice", {
            detail: { message: "Could not unlock saved Gateway credentials." },
          }),
        ),
      );
      expect(await notice?.textContent()).toContain("Could not unlock saved Gateway credentials.");
      expect(await page.getByRole("alert").count()).toBe(1);
      await capture(page, proof, "gateway-credential-notice.png");
      expect((await requests()).slice(1)).toEqual([
        {
          command: "gateway_request",
          params: { message: { type: "open-window", id: "primary" }, token: "next-document" },
        },
        {
          command: "gateway_request",
          params: {
            message: { type: "set-primary", id: "profile:studio" },
            token: "next-document",
          },
        },
        {
          command: "gateway_request",
          params: { message: { type: "open-settings" }, token: "next-document" },
        },
      ]);
      await openMenu();
      await page.getByRole("menuitemradio", { name: /Local Gateway/ }).click();
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      for (const source of ["native", "invoke"] as const) {
        await page.evaluate(() => {
          Reflect.set(window, "holdNextGatewayRequest", true);
          const { postMessage: postGatewayMessage } = Reflect.get(window, "webkit").messageHandlers
            .openclawGateways;
          Reflect.set(
            window,
            "pendingGatewayRequest",
            postGatewayMessage({ type: "select", id: "primary" }),
          );
        });
        const message =
          source === "native"
            ? "Could not remember the selected Gateway. Unlock the credential store."
            : "Could not open Gateway settings. Try again.";
        if (source === "native") {
          await page.evaluate(
            (noticeMessage) =>
              window.dispatchEvent(
                new CustomEvent("openclaw:gateway-notice", {
                  detail: { message: noticeMessage },
                }),
              ),
            message,
          );
        } else {
          await page.evaluate(() => {
            const { postMessage: postGatewayMessage } = Reflect.get(window, "webkit")
              .messageHandlers.openclawGateways;
            return postGatewayMessage({ type: "open-settings" });
          });
        }
        const warning = page.getByRole("alert").filter({ hasText: message });
        await warning.waitFor();
        await page.evaluate(async () => {
          Reflect.get(window, "completeGatewayRequest")();
          await Reflect.get(window, "pendingGatewayRequest");
        });
        expect(await warning.isVisible()).toBe(true);
        await page.evaluate(() => {
          const { postMessage: postGatewayMessage } = Reflect.get(window, "webkit").messageHandlers
            .openclawGateways;
          return postGatewayMessage({ type: "select", id: "primary" });
        });
        expect(await page.getByRole("alert").count()).toBe(0);
      }
    });
  });

  it("does not expose Gateway commands to foreign endpoints, sibling paths, or child frames", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installAdapter(page, { base: "/dashboard" });
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Isolated page</title>",
        }),
      );
      const hasBridge = () =>
        page.evaluate(() =>
          Boolean(Reflect.get(window, "webkit")?.messageHandlers?.openclawGateways),
        );
      await page.goto(`${suite.server.baseUrl}dashboard-other`);
      expect(await hasBridge()).toBe(false);
      await page.goto("http://gateway.example.test/dashboard");
      expect(await hasBridge()).toBe(false);
      await page.goto(`${suite.server.baseUrl}dashboard/chat`);
      expect(await hasBridge()).toBe(true);
      await page.evaluate(() => {
        const iframe = document.createElement("iframe");
        iframe.src = "/dashboard/child";
        document.body.append(iframe);
      });
      await expect.poll(() => page.frames().length).toBe(2);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await frame.waitForLoadState();
      expect(
        await frame.evaluate(() =>
          Boolean(Reflect.get(window, "webkit")?.messageHandlers?.openclawGateways),
        ),
      ).toBe(false);
    });
  });

  it.each([
    { width: 720, height: 520 },
    { width: 390, height: 720 },
  ])(
    "keeps the editor usable at $width × $height and preserves a failed-save draft",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const token = page.getByLabel("Gateway token (optional)", { exact: true });
        const password = page.getByLabel("Gateway password (optional)", { exact: true });
        await serveCompanion(page);
        await page.addInitScript(() => {
          Object.assign(window, {
            __TAURI__: {
              core: {
                invoke: async (_command: string, { message }: { message: { action: string } }) => {
                  if (message.action === "save") {
                    throw new Error(
                      "Could not save Gateway. Unlock the credential store and try again.",
                    );
                  }
                  return { profiles: [], selectedId: null };
                },
              },
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
        await page.getByRole("heading", { name: "Manage Gateways", exact: true }).waitFor();
        await page.getByRole("button", { name: "Add Gateway", exact: true }).click();
        await page.getByRole("heading", { name: "Add Gateway", exact: true }).waitFor();
        const name = page.getByLabel("Name", { exact: true });
        expect(await name.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(
          await page.getByRole("button", { name: "Add Gateway", exact: true }).isVisible(),
        ).toBe(false);
        expect(
          await page.getByRole("button", { name: "Back to Gateways", exact: true }).isVisible(),
        ).toBe(true);
        expect(await page.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0);
        expect(await page.getByLabel("Authentication", { exact: true }).isVisible()).toBe(true);
        expect(await token.isVisible()).toBe(true);
        expect(
          await page.getByLabel("TLS fingerprint (optional)", { exact: true }).isVisible(),
        ).toBe(false);
        await name.fill("Workshop");
        await page.getByLabel("Gateway URL", { exact: true }).fill("https://workshop.example.test");
        await page
          .getByRole("button", { name: "Save Gateway", exact: true })
          .scrollIntoViewIfNeeded();
        const card = await page.locator(".gateways-panel").boundingBox();
        expect(card).not.toBeNull();
        expect(Math.abs(card!.x - (viewport.width - card!.x - card!.width))).toBeLessThanOrEqual(2);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);

        await page.getByLabel("Connection type", { exact: true }).selectOption("ssh");
        expect(await page.getByLabel("Gateway URL", { exact: true }).isDisabled()).toBe(true);
        expect(await page.getByLabel("Gateway URL", { exact: true }).isVisible()).toBe(false);
        await page.getByLabel("SSH target", { exact: true }).fill("operator@workshop.example.test");
        expect(
          await page.getByLabel("TLS fingerprint (optional)", { exact: true }).isVisible(),
        ).toBe(false);
        await page.getByText("Advanced connection settings", { exact: true }).click();
        await page
          .getByLabel("TLS fingerprint (optional)", { exact: true })
          .fill("fixture-fingerprint");
        await token.fill("draft-token");
        await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
        const error = page.getByRole("alert").filter({ hasText: "Could not save Gateway" });
        await error.waitFor();
        expect(
          await page.getByRole("heading", { name: "Add Gateway", exact: true }).isVisible(),
        ).toBe(true);
        expect(await name.inputValue()).toBe("Workshop");
        expect(await page.getByLabel("SSH target", { exact: true }).inputValue()).toBe(
          "operator@workshop.example.test",
        );
        expect(
          await page.getByLabel("TLS fingerprint (optional)", { exact: true }).inputValue(),
        ).toBe("fixture-fingerprint");
        expect(await token.inputValue()).toBe("draft-token");
        expect(await token.isEnabled()).toBe(true);
        expect(await password.isDisabled()).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.getByRole("button", { name: "Back to Gateways", exact: true }).click();
        expect(
          await page
            .getByRole("button", { name: "Add Gateway", exact: true })
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await page.getByRole("button", { name: "Add Gateway", exact: true }).click();
        expect(await name.inputValue()).toBe("");
        expect(await page.getByLabel("Connection type", { exact: true }).inputValue()).toBe(
          "direct",
        );
        expect(await token.inputValue()).toBe("");
        expect(await token.getAttribute("type")).toBe("password");
        expect(await error.isVisible()).toBe(false);
      });
    },
  );

  it("manages profiles offline without displaying stored credentials and confirms removal", async () => {
    await suite.withPage({ viewport: { width: 980, height: 980 } }, async ({ page }) => {
      const token = page.getByLabel("Gateway token (optional)", { exact: true });
      const password = page.getByLabel("Gateway password (optional)", { exact: true });
      const parent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
      const proof = parent
        ? createControlUiE2eArtifactDir("desktop-gateway-manager", parent)
        : undefined;
      await serveCompanion(page);
      await page.addInitScript(() => {
        const profiles: Array<Record<string, unknown>> = [
          {
            id: "studio",
            name: "Studio",
            transport: "direct",
            url: "https://studio.example.test",
            hasToken: true,
            hasPassword: false,
          },
        ];
        const calls: Array<Record<string, unknown>> = [];
        let failList = true;
        Object.assign(window, {
          profileRequests: calls,
          profileCatalog: profiles,
          __TAURI__: {
            core: {
              invoke: async (
                command: string,
                { message }: { message: Record<string, unknown> },
              ) => {
                if (command !== "gateway_profile_request") {
                  throw new Error(`Unexpected command: ${command}`);
                }
                calls.push(message);
                if (message.action === "list") {
                  if (failList) {
                    failList = false;
                    throw new Error("Could not unlock saved Gateways. Try again.");
                  }
                  return structuredClone({ profiles, selectedId: "studio" });
                }
                if (message.action === "save") {
                  const connection = message.connection as Record<string, unknown>;
                  const index = profiles.findIndex((entry) => entry.id === message.id);
                  const previous = profiles[index];
                  const savedCredentials =
                    previous &&
                    !connection.token &&
                    !connection.password &&
                    previous.transport === connection.transport &&
                    previous.url === connection.url &&
                    previous.sshTarget === connection.sshTarget &&
                    previous.remotePort === connection.remotePort
                      ? previous
                      : undefined;
                  const profile = {
                    id: message.id ?? "new-profile",
                    name: message.name,
                    transport: connection.transport,
                    url: connection.url,
                    sshTarget: connection.sshTarget,
                    remotePort: connection.remotePort,
                    hasToken: savedCredentials?.hasToken ?? Boolean(connection.token),
                    hasPassword: savedCredentials?.hasPassword ?? Boolean(connection.password),
                  };
                  if (index < 0) {
                    profiles.push(profile);
                  } else {
                    profiles[index] = profile;
                  }
                  return profile;
                }
                if (message.action === "remove") {
                  profiles.splice(
                    profiles.findIndex((entry) => entry.id === message.id),
                    1,
                  );
                }
                return null;
              },
            },
          },
        });
      });
      await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
      await page
        .getByRole("alert")
        .filter({ hasText: "Could not unlock saved Gateways" })
        .waitFor();
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByRole("button", { name: "Edit Studio", exact: true }).click();
      expect(await page.getByRole("heading", { name: "Manage Gateways" }).isVisible()).toBe(false);
      expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
      expect(
        await page
          .getByLabel("Name", { exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      expect(await page.getByLabel("Authentication", { exact: true }).inputValue()).toBe("token");
      expect(await token.inputValue()).toBe("");
      expect(await password.inputValue()).toBe("");
      expect(await token.isVisible()).toBe(true);
      expect(await password.isVisible()).toBe(false);
      expect(await password.isDisabled()).toBe(true);
      await page.getByText(/Saved credentials stay hidden/).waitFor();
      await capture(page, proof, "edit-saved-gateway.png");
      await token.fill("unsaved-token");
      for (const colorScheme of ["dark", "light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect
          .poll(() =>
            page.evaluate(() => ({
              background: getComputedStyle(document.documentElement).backgroundColor,
              field: getComputedStyle(document.querySelector("#gateway-token")!).backgroundColor,
            })),
          )
          .toEqual(
            colorScheme === "light"
              ? { background: "rgb(250, 249, 247)", field: "rgb(255, 255, 255)" }
              : { background: "rgb(14, 16, 21)", field: "rgb(22, 25, 32)" },
          );
        expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe("Studio");
        expect(await token.inputValue()).toBe("unsaved-token");
        expect(await token.getAttribute("type")).toBe("password");
      }
      await page.getByRole("button", { name: "Show credential", exact: true }).click();
      expect(await token.getAttribute("type")).toBe("text");
      await page.getByRole("button", { name: "Back to Gateways", exact: true }).click();
      expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
      expect(
        await page
          .getByRole("button", { name: "Add Gateway", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      await page.getByRole("button", { name: "Edit Studio", exact: true }).click();
      expect(await token.inputValue()).toBe("");
      expect(await token.getAttribute("type")).toBe("password");
      expect(
        await page.getByRole("button", { name: "Show credential", exact: true }).isVisible(),
      ).toBe(true);
      await page.getByLabel("Name", { exact: true }).fill("  ");
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      expect(
        await page
          .getByLabel("Name", { exact: true })
          .evaluate((element: HTMLInputElement) => element.validity.valid),
      ).toBe(false);
      await page.getByRole("button", { name: "Back to Gateways", exact: true }).click();
      await page.getByRole("button", { name: "Edit Studio", exact: true }).click();
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Saved Studio" }).waitFor();
      await page.getByRole("button", { name: "Edit Studio", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Home studio");
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("button", { name: "Open Home studio", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Opened Home studio" }).waitFor();
      const requests = () =>
        page.evaluate(
          () => Reflect.get(window, "profileRequests") as Array<Record<string, unknown>>,
        );
      expect(
        (await requests()).find(
          (message) => message.action === "save" && message.name === "Home studio",
        ),
      ).toEqual({
        action: "save",
        id: "studio",
        name: "Home studio",
        connection: {
          transport: "direct",
          url: "https://studio.example.test",
          token: null,
          password: null,
        },
      });
      await page.getByRole("button", { name: "Edit Home studio", exact: true }).click();
      await token.fill("fixture-token");
      await page.getByRole("button", { name: "Show credential", exact: true }).click();
      await page.getByLabel("Authentication", { exact: true }).selectOption("password");
      expect(await token.inputValue()).toBe("");
      expect(await token.isVisible()).toBe(false);
      expect(await token.isDisabled()).toBe(true);
      expect(await password.isVisible()).toBe(true);
      expect(await password.isEnabled()).toBe(true);
      expect(await password.getAttribute("type")).toBe("password");
      await password.fill("fixture-password");
      await page.getByRole("button", { name: "Show credential", exact: true }).click();
      expect(await password.getAttribute("type")).toBe("text");
      await page.getByRole("button", { name: "Hide credential", exact: true }).click();
      expect(await password.getAttribute("type")).toBe("password");
      await page.getByLabel("Authentication", { exact: true }).selectOption("token");
      expect(await password.inputValue()).toBe("");
      await token.fill("replacement-token");
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Saved Home studio" }).waitFor();
      expect((await requests()).findLast((message) => message.action === "save")).toMatchObject({
        id: "studio",
        connection: { token: "replacement-token", password: null },
      });
      await page.getByRole("button", { name: "Edit Home studio", exact: true }).click();
      expect(await token.inputValue()).toBe("");
      expect(await password.inputValue()).toBe("");
      expect(await token.getAttribute("type")).toBe("password");
      await page.getByLabel("Authentication", { exact: true }).selectOption("password");
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Saved Home studio" }).waitFor();
      expect((await requests()).findLast((message) => message.action === "save")).toMatchObject({
        connection: { token: null, password: null },
      });
      await page.getByRole("button", { name: "Add Gateway", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Workshop");
      await page.getByLabel("Connection type", { exact: true }).selectOption("ssh");
      await page.getByLabel("SSH target", { exact: true }).fill("operator@workshop.example.test");
      await page.getByLabel("Gateway port", { exact: true }).fill("19789");
      await page.getByLabel("Authentication", { exact: true }).selectOption("password");
      await password.fill("fixture-password");
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("button", { name: "Edit Workshop", exact: true }).waitFor();
      await capture(page, proof, "saved-gateways.png");
      expect((await requests()).findLast((message) => message.action === "save")).toEqual({
        action: "save",
        name: "Workshop",
        connection: {
          transport: "ssh",
          sshTarget: "operator@workshop.example.test",
          remotePort: 19789,
          tlsFingerprint: null,
          token: null,
          password: "fixture-password",
        },
      });
      await page.getByRole("button", { name: "Edit Workshop", exact: true }).click();
      expect(await page.getByLabel("Authentication", { exact: true }).inputValue()).toBe(
        "password",
      );
      expect(await password.isVisible()).toBe(true);
      expect(await password.inputValue()).toBe("");
      await page.getByRole("button", { name: "Back to Gateways", exact: true }).click();
      await page.getByRole("button", { name: "Remove Workshop", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      expect((await requests()).filter((message) => message.action === "remove")).toHaveLength(0);
      await page.getByRole("button", { name: "Remove Workshop", exact: true }).click();
      await page.getByRole("button", { name: "Remove Gateway", exact: true }).click();
      await expect
        .poll(() => page.getByRole("button", { name: "Edit Workshop", exact: true }).count())
        .toBe(0);
      expect((await requests()).filter((message) => message.action === "remove")).toEqual([
        { action: "remove", id: "new-profile" },
      ]);
      await page.evaluate(() => {
        const catalog = Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>;
        catalog[0] = { ...catalog[0], name: "Renamed studio" };
        window.dispatchEvent(new CustomEvent("openclaw:gateway-profiles-changed", { detail: {} }));
      });
      await page.getByRole("button", { name: "Open Renamed studio", exact: true }).waitFor();
      await page.getByRole("button", { name: "Remove Renamed studio", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.evaluate(() => {
        const catalog = Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>;
        catalog[0] = { ...catalog[0], id: "relocated-studio", name: "Relocated studio" };
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-profiles-changed", {
            detail: { previousId: "studio", id: "relocated-studio" },
          }),
        );
      });
      await page.getByRole("button", { name: "Open Relocated studio", exact: true }).click();
      expect(await page.getByRole("dialog").isVisible()).toBe(false);
      expect((await requests()).filter((message) => message.action === "remove")).toHaveLength(1);
      expect((await requests()).findLast((message) => message.action === "open")?.id).toBe(
        "relocated-studio",
      );
      await page.getByRole("button", { name: "Edit Relocated studio", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("My draft");
      await page.evaluate(() => {
        const catalog = Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>;
        catalog[0] = { ...catalog[0], id: "intermediate-studio" };
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-profiles-changed", {
            detail: { previousId: "relocated-studio", id: "intermediate-studio" },
          }),
        );
        catalog[0] = {
          ...catalog[0],
          id: "moved-studio",
          name: "Moved studio",
          url: "https://moved.example.test",
        };
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-profiles-changed", {
            detail: { previousId: "intermediate-studio", id: "moved-studio" },
          }),
        );
      });
      expect(
        await page.getByRole("heading", { name: "Edit Gateway", exact: true }).isVisible(),
      ).toBe(true);
      expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe("My draft");
      expect(await page.getByLabel("Gateway URL", { exact: true }).inputValue()).toBe(
        "https://studio.example.test",
      );
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Saved My draft" }).waitFor();
      expect((await requests()).findLast((message) => message.action === "save")?.id).toBe(
        "moved-studio",
      );
      await page.getByRole("button", { name: "Edit My draft", exact: true }).click();
      await token.fill("draft-token");
      await page.evaluate(() => {
        (Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>).splice(0);
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-profiles-changed", {
            detail: { previousId: "moved-studio" },
          }),
        );
      });
      await page.getByRole("status").filter({ hasText: "removed" }).waitFor();
      await page.getByRole("heading", { name: "Add Gateway", exact: true }).waitFor();
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe("My draft");
      expect(await token.inputValue()).toBe("draft-token");
      expect(await page.getByRole("button", { name: "Open My draft", exact: true }).count()).toBe(
        0,
      );
      await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
      await page.getByRole("button", { name: "Open My draft", exact: true }).waitFor();
      expect((await requests()).findLast((message) => message.action === "save")).toMatchObject({
        name: "My draft",
        connection: { token: "draft-token" },
      });
      expect(
        (await requests()).findLast((message) => message.action === "save")?.id,
      ).toBeUndefined();
    });
  });

  it.each([
    { recoveryId: "studio", delivery: "initial" },
    { recoveryId: "removed", delivery: "initial" },
    { recoveryId: "studio", delivery: "event" },
  ])(
    "offers $delivery recovery for failed SSH profile $recoveryId without replaying its error after save",
    async ({ recoveryId, delivery }) => {
      await suite.withPage({}, async ({ page }) => {
        await serveCompanion(page);
        await page.addInitScript(
          ({ id, eventDelivery }) => {
            let profile = {
              id: "studio",
              name: "Studio",
              transport: "ssh",
              sshTarget: "operator@unreachable.example.test",
              remotePort: 18789,
              hasToken: true,
              hasPassword: false,
            };
            const calls: Array<Record<string, unknown>> = [];
            let publishSaveFailure = eventDelivery;
            Object.assign(window, {
              replaceGatewayProfile: () => {
                profile = {
                  ...profile,
                  id: "external-studio",
                  name: "Other studio",
                  sshTarget: "operator@elsewhere.example.test",
                };
              },
              __OPENCLAW_GATEWAY_RECOVERY__: {
                id,
                error: eventDelivery
                  ? ""
                  : "SSH connection failed. Check the target and try again.",
              },
              profileRequests: calls,
              __TAURI__: {
                core: {
                  invoke: async (
                    _command: string,
                    { message }: { message: Record<string, unknown> },
                  ) => {
                    calls.push(message);
                    if (message.action === "list") {
                      if (publishSaveFailure && profile.id === "updated-studio") {
                        publishSaveFailure = false;
                        const detail = {
                          id: profile.id,
                          error: "Updated SSH connection failed. Check the new target.",
                        };
                        Reflect.set(window, "__OPENCLAW_GATEWAY_RECOVERY__", detail);
                        window.dispatchEvent(
                          new CustomEvent("openclaw:gateway-recovery", { detail }),
                        );
                      }
                      return { profiles: [profile], selectedId: "studio" };
                    }
                    if (message.action === "save") {
                      if (message.id && message.id !== profile.id) {
                        throw new Error("That saved Gateway no longer exists.");
                      }
                      profile = {
                        ...profile,
                        id: eventDelivery ? "updated-studio" : profile.id,
                        name: String(message.name),
                      };
                      return profile;
                    }
                    return null;
                  },
                },
              },
            });
          },
          { id: recoveryId, eventDelivery: delivery === "event" },
        );
        await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
        if (delivery !== "event") {
          await page.getByRole("alert").filter({ hasText: "SSH connection failed" }).waitFor();
        }
        if (recoveryId === "studio") {
          await page.getByRole("heading", { name: "Edit Gateway", exact: true }).waitFor();
          expect(await page.getByLabel("SSH target", { exact: true }).inputValue()).toBe(
            "operator@unreachable.example.test",
          );
        } else {
          expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
          await page
            .getByRole("button", { name: "Open Studio", exact: true })
            .click({ trial: true });
          await page.getByRole("button", { name: "Add Gateway", exact: true }).click();
          await page.getByLabel("Connection type", { exact: true }).selectOption("ssh");
        }
        expect(
          await page.getByLabel("Gateway token (optional)", { exact: true }).inputValue(),
        ).toBe("");
        expect(
          await page.getByLabel("Gateway password (optional)", { exact: true }).inputValue(),
        ).toBe("");
        await page.getByLabel("Name", { exact: true }).fill("Recovered studio");
        await page.getByLabel("SSH target", { exact: true }).fill("operator@studio.example.test");
        if (delivery === "event") {
          expect(await page.locator("#gateway-error").getAttribute("hidden")).not.toBeNull();
          await page.getByLabel("Gateway token (optional)", { exact: true }).fill("unsaved-token");
          await page.evaluate(() => {
            Reflect.get(window, "replaceGatewayProfile")();
            const detail = {
              id: "external-studio",
              error: "SSH connection failed. Check the target and try again.",
            };
            Reflect.set(window, "__OPENCLAW_GATEWAY_RECOVERY__", detail);
            window.dispatchEvent(new CustomEvent("openclaw:gateway-recovery", { detail }));
          });
          await page.getByRole("alert").filter({ hasText: "SSH connection failed" }).waitFor();
          expect(
            await page.getByRole("heading", { name: "Edit Gateway", exact: true }).isVisible(),
          ).toBe(true);
          expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
          expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(
            "Recovered studio",
          );
          expect(await page.getByLabel("SSH target", { exact: true }).inputValue()).toBe(
            "operator@studio.example.test",
          );
          expect(
            await page.getByLabel("Gateway token (optional)", { exact: true }).inputValue(),
          ).toBe("unsaved-token");
          await page.getByLabel("Gateway token (optional)", { exact: true }).fill("");
        }
        await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
        if (delivery === "event") {
          await page
            .getByRole("alert")
            .filter({ hasText: "Updated SSH connection failed" })
            .waitFor();
          await page.getByRole("heading", { name: "Edit Gateway", exact: true }).waitFor();
          expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(
            "Recovered studio",
          );
          await page.getByLabel("Name", { exact: true }).fill("Ready studio");
          await page.getByRole("button", { name: "Save Gateway", exact: true }).click();
          await page.getByRole("status").filter({ hasText: "Saved Ready studio" }).waitFor();
          const lastSave = await page.evaluate(() =>
            (Reflect.get(window, "profileRequests") as Array<Record<string, unknown>>).findLast(
              (message) => message.action === "save",
            ),
          );
          expect(lastSave?.id).toBe("updated-studio");
        } else {
          await page.getByRole("status").filter({ hasText: "Saved Recovered studio" }).waitFor();
        }
        expect(await page.getByRole("alert").isVisible()).toBe(false);
        expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
        const saved = await page.evaluate(() =>
          (Reflect.get(window, "profileRequests") as Array<Record<string, unknown>>).find(
            (message) => message.action === "save",
          ),
        );
        expect(saved).toEqual({
          action: "save",
          ...(recoveryId === "studio"
            ? { id: delivery === "event" ? "external-studio" : "studio" }
            : {}),
          name: "Recovered studio",
          connection: {
            transport: "ssh",
            sshTarget: "operator@studio.example.test",
            remotePort: 18789,
            tlsFingerprint: null,
            token: null,
            password: null,
          },
        });
      });
    },
  );
});
