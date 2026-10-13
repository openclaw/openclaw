import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { serveCompanion } from "./native-desktop.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop appearance E2E" });
const schemes = ["light", "dark"] as const;
type Scheme = (typeof schemes)[number];
type NativeRequest = { command: string; params?: Record<string, unknown> };

async function installNative(page: Page) {
  await serveCompanion(page);
  await page.addInitScript(() => {
    const requests: Array<{ command: string; params?: Record<string, unknown> }> = [];
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });
    const primaryAgent = { id: "main", name: "Assistant", isDefault: true };
    const agents = [
      primaryAgent,
      { id: "writer", name: "Writing assistant for long project names", isDefault: false },
    ];
    let selectedAgent = primaryAgent;
    let firstConnection = true;
    let deferNextIdentity = false;
    let releaseIdentity: ((fail: boolean) => void) | undefined;
    Object.assign(window, {
      nativeRequests: requests,
      emitNativeEvent: emit,
      deferNativeIdentity: () => {
        deferNextIdentity = true;
      },
      hasDeferredNativeIdentity: () => Boolean(releaseIdentity),
      releaseNativeIdentity: (fail = false) => {
        releaseIdentity?.(fail);
        releaseIdentity = undefined;
      },
      __TAURI__: {
        event: {
          listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
            listeners.set(name, callback);
            return () => listeners.delete(name);
          },
        },
        core: {
          invoke: async (command: string, params?: Record<string, unknown>) => {
            requests.push({ command, params });
            switch (command) {
              case "discover_gateways":
                return [];
              case "build_info":
                return { platform: "linux", releaseBuild: false };
              case "bootstrap":
                if (params?.connectionSettings) {
                  return {
                    phase: "remoteError",
                    remote: { transport: "direct", url: "https://saved.example.test" },
                  };
                }
                return params?.remoteRetry
                  ? { phase: "remoteError", detail: "The saved Gateway is still unavailable." }
                  : { phase: "missingCli" };
              case "connect_remote_gateway":
                if (firstConnection) {
                  firstConnection = false;
                  throw new Error("Gateway rejected the credential. Check it and try again.");
                }
                return null;
              case "install_cli":
                throw new Error("Download unavailable. Try installation again.");
              case "quickchat_ready":
                emit("quickchat:gateway-state", { state: "up", gatewayGeneration: 1 });
                return true;
              case "quickchat_agents":
                return agents;
              case "quickchat_identity":
                if (deferNextIdentity) {
                  deferNextIdentity = false;
                  const snapshot = selectedAgent;
                  return new Promise<typeof selectedAgent>((resolve, reject) => {
                    releaseIdentity = (fail) => {
                      if (fail) {
                        reject(new Error("Identity refresh unavailable"));
                      } else {
                        resolve(snapshot);
                      }
                    };
                  });
                }
                return selectedAgent;
              case "quickchat_select_agent": {
                const requestedAgent = agents.find((agent) => agent.id === params?.agentId);
                if (!requestedAgent) {
                  throw new Error(`Unknown fixture agent: ${String(params?.agentId)}`);
                }
                selectedAgent = requestedAgent;
                return selectedAgent;
              }
              case "quickchat_shortcut":
              case "quickchat_set_shortcut":
                return {
                  supported: true,
                  enabled: true,
                  accelerator: params?.accelerator ?? "Ctrl+Space",
                };
              case "quickchat_send": {
                const target = {
                  sessionKey: `agent:${selectedAgent.id}:quickchat`,
                  agentId: selectedAgent.id,
                  gatewayGeneration: 1,
                  runId: "reply-1",
                };
                emit("quickchat:send-prepared", target);
                return { ...target, status: "started" };
              }
              case "quickchat_activate":
              case "quickchat_hide":
                return true;
              case "quickchat_set_expanded":
              case "quickchat_sync_widgets":
              case "close_connection_settings":
              case "gateway_action":
              case "updater_ready":
              case "relaunch":
                return null;
              default:
                throw new Error(`Unexpected native command: ${command}`);
            }
          },
        },
      },
    });
  });
  return {
    deferIdentity: () => page.evaluate(() => Reflect.get(window, "deferNativeIdentity")()),
    identityPending: () => page.evaluate(() => Reflect.get(window, "hasDeferredNativeIdentity")()),
    releaseIdentity: (fail = false) =>
      page.evaluate((shouldFail) => Reflect.get(window, "releaseNativeIdentity")(shouldFail), fail),
    requests: (command: string) =>
      page.evaluate(
        (name) =>
          (Reflect.get(window, "nativeRequests") as NativeRequest[]).filter(
            (request) => request.command === name,
          ),
        command,
      ),
    emit: (name: string, payload: unknown) =>
      page.evaluate(
        ({ eventName, eventPayload }) =>
          Reflect.get(window, "emitNativeEvent")(eventName, eventPayload),
        { eventName: name, eventPayload: payload },
      ),
  };
}

async function expectAppearance(page: Page, scheme: Scheme, surface = ".panel", text = "h1") {
  await page.emulateMedia({ colorScheme: scheme });
  const appearance = () =>
    page.evaluate(
      ({ surfaceSelector, textSelector }) => {
        const luminance = (color: string) => {
          const components = /^rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/u.exec(color);
          if (!components) {
            throw new Error(`Expected opaque RGB color, received ${color}`);
          }
          const red = Number(components[1]);
          const green = Number(components[2]);
          const blue = Number(components[3]);
          if (
            [red, green, blue].some(
              (channel) => !Number.isFinite(channel) || channel < 0 || channel > 255,
            )
          ) {
            throw new Error(`Invalid RGB components: ${color}`);
          }
          const linear = (channel: number) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          };
          return linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722;
        };
        const background = luminance(
          getComputedStyle(document.querySelector(surfaceSelector)!).backgroundColor,
        );
        const foreground = luminance(getComputedStyle(document.querySelector(textSelector)!).color);
        return {
          light: background > 0.5,
          contrast:
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
        };
      },
      { surfaceSelector: surface, textSelector: text },
    );
  await expect.poll(async () => (await appearance()).light).toBe(scheme === "light");
  expect((await appearance()).contrast).toBeGreaterThanOrEqual(4.5);
}

async function expectControlsFit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .locator("button:visible, input:visible, textarea:visible, select:visible")
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            const bounds = control.getBoundingClientRect();
            return bounds.left < 0 || bounds.right > window.innerWidth;
          })
          .map((control) => control.getAttribute("aria-label") ?? control.id),
      ),
  ).toEqual([]);
}

suite.define(() => {
  it.each(schemes)(
    "keeps remote setup drafts and authentication usable from %s appearance",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, viewport: { width: 560, height: 900 } },
        async ({ page }) => {
          const native = await installNative(page);
          await page.goto(`${suite.server.baseUrl}companion/index.html`);
          await page.getByRole("heading", { name: "Welcome to OpenClaw" }).waitFor();
          await expectAppearance(page, colorScheme);
          await page.getByRole("button", { name: "Get started" }).click();
          await page.getByRole("button", { name: /On another computer/ }).click();
          const connect = page.getByRole("button", { name: "Connect to Gateway", exact: true });
          await connect.click();
          await page.getByRole("status").filter({ hasText: "Enter a Gateway URL" }).waitFor();
          expect(await native.requests("connect_remote_gateway")).toEqual([]);
          const url = page.getByLabel("Gateway URL", { exact: true });
          const token = page.getByLabel("Gateway token", { exact: true });
          const password = page.getByLabel("Gateway password", { exact: true });
          await url.fill("https://gateway.example.test");
          await token.fill("draft-token");
          for (const scheme of schemes) {
            await expectAppearance(page, scheme);
            expect(await url.inputValue()).toBe("https://gateway.example.test");
            expect(await token.inputValue()).toBe("draft-token");
            expect(await token.getAttribute("type")).toBe("password");
            await expectControlsFit(page);
          }
          await page.getByRole("button", { name: "Show credential", exact: true }).click();
          expect(await token.getAttribute("type")).toBe("text");
          await page.getByLabel("Authentication", { exact: true }).selectOption("password");
          expect(await token.inputValue()).toBe("");
          expect(await token.isDisabled()).toBe(true);
          expect(await password.getAttribute("type")).toBe("password");
          await password.fill("draft-password");
          await connect.click();
          await page
            .getByRole("status")
            .filter({ hasText: "Gateway rejected the credential" })
            .waitFor();
          expect(await password.inputValue()).toBe("draft-password");
          expect(await connect.isEnabled()).toBe(true);
          expect(await native.requests("connect_remote_gateway")).toEqual([
            {
              command: "connect_remote_gateway",
              params: {
                transport: "direct",
                url: "https://gateway.example.test",
                sshTarget: null,
                token: null,
                password: "draft-password",
                remotePort: null,
              },
            },
          ]);
          await page.getByRole("button", { name: "SSH tunnel", exact: true }).click();
          await page
            .getByLabel("SSH target", { exact: true })
            .fill("operator@gateway.example.test");
          await page.getByLabel("Gateway port", { exact: true }).fill("0");
          await connect.click();
          await page.getByRole("status").filter({ hasText: "between 1 and 65535" }).waitFor();
          expect(await native.requests("connect_remote_gateway")).toHaveLength(1);
          await page.getByLabel("Gateway port", { exact: true }).fill("18789");
          await page.getByLabel("Gateway port", { exact: true }).press("Enter");
          await page
            .getByRole("status")
            .filter({ hasText: "Opening the remote dashboard" })
            .waitFor();
          expect((await native.requests("connect_remote_gateway")).slice(1)).toEqual([
            {
              command: "connect_remote_gateway",
              params: {
                transport: "ssh",
                url: null,
                sshTarget: "operator@gateway.example.test",
                token: null,
                password: "draft-password",
                remotePort: 18789,
              },
            },
          ]);
          await expectControlsFit(page);
        },
      );
    },
  );

  it.each(schemes)(
    "keeps saved-route recovery separate from credential editing in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, viewport: { width: 560, height: 900 } },
        async ({ page }) => {
          const native = await installNative(page);
          await page.goto(`${suite.server.baseUrl}companion/index.html?mode=remoteError`);
          await page.getByRole("heading", { name: "Connection needs attention" }).waitFor();
          await expectAppearance(page, colorScheme);
          await page.getByRole("button", { name: "Retry", exact: true }).click();
          await page
            .getByText("The saved Gateway is still unavailable.", { exact: true })
            .waitFor();
          expect(await native.requests("bootstrap")).toEqual([
            { command: "bootstrap", params: { remoteRetry: true } },
          ]);
          await page.getByRole("button", { name: "Edit connection", exact: true }).click();
          await expect
            .poll(() => page.getByLabel("Gateway URL", { exact: true }).inputValue())
            .toBe("https://saved.example.test");
          const credential = page.getByLabel("Gateway token", { exact: true });
          expect(await credential.inputValue()).toBe("");
          await credential.fill("replacement-draft");
          await expectAppearance(page, colorScheme === "light" ? "dark" : "light");
          expect(await credential.inputValue()).toBe("replacement-draft");
          expect(await credential.getAttribute("type")).toBe("password");
          await expectControlsFit(page);
          await page.getByRole("button", { name: "Back", exact: true }).click();
          expect(await native.requests("close_connection_settings")).toHaveLength(1);
          expect(await native.requests("connect_remote_gateway")).toEqual([]);
          expect(await native.requests("gateway_action")).toEqual([]);
        },
      );
    },
  );

  it.each(schemes)(
    "keeps installation, stopped, reconnecting, and update actions readable in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, viewport: { width: 400, height: 900 } },
        async ({ page }) => {
          const native = await installNative(page);
          await page.goto(`${suite.server.baseUrl}companion/index.html?mode=missingCli`);
          await page.getByRole("heading", { name: "OpenClaw needs the CLI" }).waitFor();
          await page.getByLabel("Release channel", { exact: true }).selectOption("beta");
          await expectAppearance(page, colorScheme);
          await expectControlsFit(page);
          await page.getByRole("button", { name: "Install OpenClaw", exact: true }).click();
          await page.getByRole("heading", { name: "OpenClaw needs attention" }).waitFor();
          expect(await native.requests("install_cli")).toEqual([
            { command: "install_cli", params: { channel: "beta" } },
          ]);
          expect(await page.getByLabel("Release channel", { exact: true }).inputValue()).toBe(
            "beta",
          );
          expect(
            await page.getByRole("button", { name: "Install OpenClaw", exact: true }).isEnabled(),
          ).toBe(true);
          await expectAppearance(page, colorScheme);
          await page.goto(`${suite.server.baseUrl}companion/index.html?mode=stopped`);
          await page.getByRole("button", { name: "Start Gateway", exact: true }).waitFor();
          await expectAppearance(page, colorScheme);
          await page.getByRole("button", { name: "Start Gateway", exact: true }).click();
          expect(await native.requests("gateway_action")).toEqual([
            { command: "gateway_action", params: { action: "start" } },
          ]);
          await page.goto(`${suite.server.baseUrl}companion/index.html?mode=reconnecting`);
          await page.getByRole("heading", { name: "Reconnecting", exact: true }).waitFor();
          await native.emit("updater://ready", { version: "1.2.3" });
          await page.getByRole("button", { name: "Restart to update", exact: true }).waitFor();
          await expectAppearance(page, colorScheme);
          await expectControlsFit(page);
          await page.getByRole("button", { name: "Restart to update", exact: true }).click();
          expect(await native.requests("relaunch")).toHaveLength(1);
          await page.getByRole("button", { name: "Dismiss update notice", exact: true }).click();
          expect(
            await page.getByRole("button", { name: "Restart to update", exact: true }).isVisible(),
          ).toBe(false);
        },
      );
    },
  );

  it.each(schemes)(
    "preserves Quick Chat drafts, agent choice, and replies across %s appearance changes",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, reducedMotion: "reduce", viewport: { width: 400, height: 560 } },
        async ({ page }) => {
          const native = await installNative(page);
          await page.goto(`${suite.server.baseUrl}companion/quickchat.html`);
          const message = page.getByRole("textbox", { name: "Quick Chat message", exact: true });
          await expect.poll(() => message.getAttribute("placeholder")).toBe("Message Assistant");
          await native.deferIdentity();
          await native.emit("quickchat:shown", {});
          await expect.poll(() => native.identityPending()).toBe(true);
          await message.fill("Please summarize the project notes.");
          await page.getByRole("button", { name: "Choose agent", exact: true }).click();
          for (const scheme of schemes) {
            await expectAppearance(page, scheme, ".composer", "#message");
            await expectAppearance(page, scheme, "#agent-menu", ".agent-option-name");
            expect(await message.inputValue()).toBe("Please summarize the project notes.");
            expect(await page.getByRole("menu").isVisible()).toBe(true);
            await expectControlsFit(page);
          }
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          await expect
            .poll(() => message.getAttribute("placeholder"))
            .toBe("Message Writing assistant for long project names");
          expect(await native.requests("quickchat_select_agent")).toEqual([
            { command: "quickchat_select_agent", params: { agentId: "writer" } },
          ]);
          await page
            .getByRole("button", { name: "Quick Chat shortcut settings", exact: true })
            .click();
          await page.getByRole("button", { name: "Press new shortcut", exact: true }).click();
          await page.keyboard.press("Control+Shift+K");
          await expect
            .poll(() => page.locator("#shortcut-value").textContent())
            .toBe("Ctrl+Shift+KeyK");
          expect(await native.requests("quickchat_set_shortcut")).toEqual([
            { command: "quickchat_set_shortcut", params: { accelerator: "Ctrl+Shift+KeyK" } },
          ]);
          await expectControlsFit(page);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.getByRole("region", { name: "Agent reply", exact: true }).waitFor();
          expect(await native.requests("quickchat_send")).toEqual([
            {
              command: "quickchat_send",
              params: { message: "Please summarize the project notes." },
            },
          ]);
          expect(await message.inputValue()).toBe("");
          const reply = {
            gatewayGeneration: 1,
            runId: "reply-1",
            sessionKey: "agent:writer:quickchat",
            agentId: "writer",
          };
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: "The project is ready.",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "The project is ready." }],
            },
          });
          await page.getByText("The project is ready.", { exact: true }).waitFor();
          await native.releaseIdentity();
          expect(await message.getAttribute("placeholder")).toBe(
            "Message Writing assistant for long project names",
          );
          expect(await page.getByText("The project is ready.", { exact: true }).isVisible()).toBe(
            true,
          );
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("A follow-up draft");
          await message.press("Shift+Enter");
          await page.keyboard.type("with another line");
          expect(
            await page.getByRole("button", { name: "Choose agent", exact: true }).isDisabled(),
          ).toBe(true);
          for (const scheme of schemes) {
            await expectAppearance(page, scheme, ".composer", "#reply-text");
            expect(await page.getByText("The project is ready.", { exact: true }).isVisible()).toBe(
              true,
            );
            expect(await message.getAttribute("readonly")).toBeNull();
            expect(
              await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(),
            ).toBe(true);
          }
          await page.getByRole("button", { name: "Collapse reply", exact: true }).click();
          await expect.poll(() => page.locator("#reply").isVisible()).toBe(false);
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: " The next step is review.",
          });
          expect(await message.inputValue()).toBe("A follow-up draft\nwith another line");
          await page.getByRole("button", { name: "Expand reply", exact: true }).click();
          await page
            .getByText("The project is ready. The next step is review.", { exact: true })
            .waitFor();
          expect(await message.inputValue()).toBe("A follow-up draft\nwith another line");
          expect(await page.locator("#composer textarea").count()).toBe(1);
          expect(await native.requests("quickchat_send")).toHaveLength(1);
          await native.emit("quickchat:chat-event", { ...reply, state: "final" });
          await expect
            .poll(() =>
              page.getByRole("button", { name: "Choose agent", exact: true }).isDisabled(),
            )
            .toBe(false);
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("A follow-up draft");
          await native.emit("quickchat:gateway-state", {
            state: "down",
            gatewayGeneration: 1,
            notice: "Gateway unavailable. Reconnecting…",
          });
          await page.getByRole("alert").filter({ hasText: "Gateway unavailable" }).waitFor();
          expect(
            await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(),
          ).toBe(true);
          expect(await message.inputValue()).toBe("A follow-up draft");
          await expectControlsFit(page);
        },
      );
    },
  );
  it.each(schemes)(
    "retains the active Quick Chat reply when an identity refresh fails in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, reducedMotion: "reduce", viewport: { width: 640, height: 520 } },
        async ({ page }) => {
          const native = await installNative(page);
          await page.goto(`${suite.server.baseUrl}companion/quickchat.html`);
          const message = page.getByRole("textbox", { name: "Quick Chat message", exact: true });
          await expect.poll(() => message.getAttribute("placeholder")).toBe("Message Assistant");
          await native.deferIdentity();
          await native.emit("quickchat:shown", {});
          await expect.poll(() => native.identityPending()).toBe(true);
          await message.fill("Summarize the project.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const reply = {
            gatewayGeneration: 1,
            runId: "reply-1",
            sessionKey: "agent:main:quickchat",
            agentId: "main",
          };
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: "Ready.",
            message: { role: "assistant", content: [{ type: "text", text: "Ready." }] },
          });
          await page.getByText("Ready.", { exact: true }).waitFor();
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("Keep this draft.");
          await native.releaseIdentity(true);
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: " Still connected.",
          });
          await page.getByText("Ready. Still connected.", { exact: true }).waitFor();
          expect(await message.inputValue()).toBe("Keep this draft.");
          expect(
            await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(),
          ).toBe(true);
          await native.emit("quickchat:chat-event", { ...reply, state: "final" });
          await expect
            .poll(() =>
              page.getByRole("button", { name: "Send message", exact: true }).isDisabled(),
            )
            .toBe(false);
        },
      );
    },
  );
});
