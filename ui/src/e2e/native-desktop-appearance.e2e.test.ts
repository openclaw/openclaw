import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { serveCompanion } from "./native-desktop.test-support.ts";
import { expectControl, nativeForm } from "./native-form.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop appearance E2E" });
const schemes = ["light", "dark"] as const;
type Scheme = (typeof schemes)[number];
type NativeRequest = { command: string; params?: Record<string, unknown> };
type Native = Awaited<ReturnType<typeof installNative>>;

async function expectRequest(
  native: Native,
  command: string,
  params: Record<string, unknown>,
  offset = 0,
) {
  expect((await native.requests(command)).slice(offset)).toEqual([{ command, params }]);
}

function withNative(
  colorScheme: Scheme,
  [width, height]: [number, number],
  run: (page: Page, native: Native, form: ReturnType<typeof nativeForm>) => Promise<void>,
  quickChat = false,
) {
  return suite.withPage(
    {
      colorScheme,
      ...(quickChat ? { reducedMotion: "reduce" as const } : {}),
      viewport: { width, height },
    },
    async ({ page }) => run(page, await installNative(page), nativeForm(page)),
  );
}

const status = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text }).waitFor();

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
            ({ command: requestedCommand }) => requestedCommand === name,
          ),
        command,
      ),
    emit: (name: string, payload: unknown) =>
      page.evaluate(
        ([eventName, eventPayload]) =>
          Reflect.get(window, "emitNativeEvent")(eventName, eventPayload),
        [name, payload] as const,
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
          const linear = (channel: string) => {
            const value = Number(channel) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          };
          return [0.2126, 0.7152, 0.0722].reduce(
            (sum, weight, index) => sum + linear(components[index + 1]!) * weight,
            0,
          );
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

async function openQuickChat(page: Page) {
  await page.goto(`${suite.server.baseUrl}companion/quickchat.html`);
  const message = page.getByRole("textbox", { name: "Quick Chat message", exact: true });
  await expect.poll(() => message.getAttribute("placeholder")).toBe("Message Assistant");
  return message;
}

async function deferIdentity(native: Native) {
  await native.deferIdentity();
  await native.emit("quickchat:shown", {});
  await expect.poll(() => native.identityPending()).toBe(true);
}

async function startReply(native: Native, agentId: string, text: string) {
  const reply = {
    gatewayGeneration: 1,
    runId: "reply-1",
    sessionKey: `agent:${agentId}:quickchat`,
    agentId,
  };
  await native.emit("quickchat:chat-event", {
    ...reply,
    state: "delta",
    deltaText: text,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  return reply;
}

suite.define(() => {
  it.each(schemes)(
    "keeps remote setup drafts and authentication usable from %s appearance",
    async (colorScheme) => {
      await withNative(colorScheme, [560, 900], async (page, native, form) => {
        await page.goto(`${suite.server.baseUrl}companion/index.html`);
        await page.getByRole("heading", { name: "Welcome to OpenClaw" }).waitFor();
        await expectAppearance(page, colorScheme);
        await page.getByRole("button", { name: "Get started" }).click();
        await page.getByRole("button", { name: /On another computer/ }).click();
        const connect = form.button("Connect to Gateway");
        await connect.click();
        await status(page, "Enter a Gateway URL");
        expect(await native.requests("connect_remote_gateway")).toEqual([]);
        const url = form.field("Gateway URL");
        const token = form.field("Gateway token");
        const password = form.field("Gateway password");
        const direct = {
          transport: "direct",
          url: "https://gateway.example.test",
          sshTarget: null,
          token: null,
          password: "draft-password",
          remotePort: null,
        };
        await url.fill("https://gateway.example.test");
        await token.fill("draft-token");
        for (const scheme of schemes) {
          await expectAppearance(page, scheme);
          expect(await url.inputValue()).toBe("https://gateway.example.test");
          await expectControl(token, { value: "draft-token", type: "password" });
          await expectControlsFit(page);
        }
        await form.button("Show credential").click();
        expect(await token.getAttribute("type")).toBe("text");
        await form.field("Authentication").selectOption("password");
        await expectControl(token, { value: "", disabled: true });
        expect(await password.getAttribute("type")).toBe("password");
        await password.fill("draft-password");
        await connect.click();
        await status(page, "Gateway rejected the credential");
        expect(await password.inputValue()).toBe("draft-password");
        expect(await connect.isEnabled()).toBe(true);
        await expectRequest(native, "connect_remote_gateway", direct);
        await form.button("SSH tunnel").click();
        await form.field("SSH target").fill("operator@gateway.example.test");
        await form.field("Gateway port").fill("0");
        await connect.click();
        await status(page, "between 1 and 65535");
        expect(await native.requests("connect_remote_gateway")).toHaveLength(1);
        await form.field("Gateway port").fill("18789");
        await form.field("Gateway port").press("Enter");
        await status(page, "Opening the remote dashboard");
        await expectRequest(
          native,
          "connect_remote_gateway",
          {
            ...direct,
            transport: "ssh",
            url: null,
            sshTarget: "operator@gateway.example.test",
            remotePort: 18789,
          },
          1,
        );
        await expectControlsFit(page);
      });
    },
  );

  it.each(schemes)(
    "keeps saved-route recovery separate from credential editing in %s mode",
    async (colorScheme) => {
      await withNative(colorScheme, [560, 900], async (page, native, form) => {
        await page.goto(`${suite.server.baseUrl}companion/index.html?mode=remoteError`);
        await page.getByRole("heading", { name: "Connection needs attention" }).waitFor();
        await expectAppearance(page, colorScheme);
        await form.button("Retry").click();
        await form.text("The saved Gateway is still unavailable.").waitFor();
        await expectRequest(native, "bootstrap", { remoteRetry: true });
        await form.button("Edit connection").click();
        await expect
          .poll(() => form.field("Gateway URL").inputValue())
          .toBe("https://saved.example.test");
        const credential = form.field("Gateway token");
        expect(await credential.inputValue()).toBe("");
        await credential.fill("replacement-draft");
        await expectAppearance(page, colorScheme === "light" ? "dark" : "light");
        await expectControl(credential, { value: "replacement-draft", type: "password" });
        await expectControlsFit(page);
        await form.button("Back").click();
        expect(await native.requests("close_connection_settings")).toHaveLength(1);
        expect(await native.requests("connect_remote_gateway")).toEqual([]);
        expect(await native.requests("gateway_action")).toEqual([]);
      });
    },
  );

  it.each(schemes)(
    "keeps installation, stopped, reconnecting, and update actions readable in %s mode",
    async (colorScheme) => {
      await withNative(colorScheme, [400, 900], async (page, native, form) => {
        await page.goto(`${suite.server.baseUrl}companion/index.html?mode=missingCli`);
        await page.getByRole("heading", { name: "OpenClaw needs the CLI" }).waitFor();
        await form.field("Release channel").selectOption("beta");
        await expectAppearance(page, colorScheme);
        await expectControlsFit(page);
        await form.button("Install OpenClaw").click();
        await page.getByRole("heading", { name: "OpenClaw needs attention" }).waitFor();
        await expectRequest(native, "install_cli", { channel: "beta" });
        expect(await form.field("Release channel").inputValue()).toBe("beta");
        expect(await form.button("Install OpenClaw").isEnabled()).toBe(true);
        await expectAppearance(page, colorScheme);
        await page.goto(`${suite.server.baseUrl}companion/index.html?mode=stopped`);
        await form.button("Start Gateway").waitFor();
        await expectAppearance(page, colorScheme);
        await form.button("Start Gateway").click();
        await expectRequest(native, "gateway_action", { action: "start" });
        await page.goto(`${suite.server.baseUrl}companion/index.html?mode=reconnecting`);
        await form.heading("Reconnecting").waitFor();
        await native.emit("updater://ready", { version: "1.2.3" });
        await form.button("Restart to update").waitFor();
        await expectAppearance(page, colorScheme);
        await expectControlsFit(page);
        await form.button("Restart to update").click();
        expect(await native.requests("relaunch")).toHaveLength(1);
        await form.button("Dismiss update notice").click();
        expect(await form.button("Restart to update").isVisible()).toBe(false);
      });
    },
  );

  it.each(schemes)(
    "preserves Quick Chat drafts, agent choice, and replies across %s appearance changes",
    async (colorScheme) => {
      await withNative(
        colorScheme,
        [400, 560],
        async (page, native, form) => {
          const message = await openQuickChat(page);
          await deferIdentity(native);
          await message.fill("Please summarize the project notes.");
          await form.button("Choose agent").click();
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
          await expectRequest(native, "quickchat_select_agent", { agentId: "writer" });
          await form.button("Quick Chat shortcut settings").click();
          await form.button("Press new shortcut").click();
          await page.keyboard.press("Control+Shift+K");
          await expect
            .poll(() => page.locator("#shortcut-value").textContent())
            .toBe("Ctrl+Shift+KeyK");
          await expectRequest(native, "quickchat_set_shortcut", { accelerator: "Ctrl+Shift+KeyK" });
          await expectControlsFit(page);
          await page.keyboard.press("Escape");
          await form.button("Send message").click();
          await page.getByRole("region", { name: "Agent reply", exact: true }).waitFor();
          await expectRequest(native, "quickchat_send", {
            message: "Please summarize the project notes.",
          });
          expect(await message.inputValue()).toBe("");
          const reply = await startReply(native, "writer", "The project is ready.");
          await form.text("The project is ready.").waitFor();
          await native.releaseIdentity();
          expect(await message.getAttribute("placeholder")).toBe(
            "Message Writing assistant for long project names",
          );
          expect(await form.text("The project is ready.").isVisible()).toBe(true);
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("A follow-up draft");
          await message.press("Shift+Enter");
          await page.keyboard.type("with another line");
          expect(await form.button("Choose agent").isDisabled()).toBe(true);
          for (const scheme of schemes) {
            await expectAppearance(page, scheme, ".composer", "#reply-text");
            expect(await form.text("The project is ready.").isVisible()).toBe(true);
            expect(await message.getAttribute("readonly")).toBeNull();
            expect(await form.button("Send message").isDisabled()).toBe(true);
          }
          await form.button("Collapse reply").click();
          await expect.poll(() => page.locator("#reply").isVisible()).toBe(false);
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: " The next step is review.",
          });
          expect(await message.inputValue()).toBe("A follow-up draft\nwith another line");
          await form.button("Expand reply").click();
          await form.text("The project is ready. The next step is review.").waitFor();
          expect(await message.inputValue()).toBe("A follow-up draft\nwith another line");
          expect(await page.locator("#composer textarea").count()).toBe(1);
          expect(await native.requests("quickchat_send")).toHaveLength(1);
          await native.emit("quickchat:chat-event", { ...reply, state: "final" });
          await expect.poll(() => form.button("Choose agent").isDisabled()).toBe(false);
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("A follow-up draft");
          await native.emit("quickchat:gateway-state", {
            state: "down",
            gatewayGeneration: 1,
            notice: "Gateway unavailable. Reconnecting…",
          });
          await page.getByRole("alert").filter({ hasText: "Gateway unavailable" }).waitFor();
          expect(await form.button("Send message").isDisabled()).toBe(true);
          expect(await message.inputValue()).toBe("A follow-up draft");
          await expectControlsFit(page);
        },
        true,
      );
    },
  );
  it.each(schemes)(
    "retains the active Quick Chat reply when an identity refresh fails in %s mode",
    async (colorScheme) => {
      await withNative(
        colorScheme,
        [640, 520],
        async (page, native, form) => {
          const message = await openQuickChat(page);
          await deferIdentity(native);
          await message.fill("Summarize the project.");
          await form.button("Send message").click();
          const reply = await startReply(native, "main", "Ready.");
          await form.text("Ready.").waitFor();
          await expect.poll(() => message.getAttribute("readonly")).toBeNull();
          await message.fill("Keep this draft.");
          await native.releaseIdentity(true);
          await native.emit("quickchat:chat-event", {
            ...reply,
            state: "delta",
            deltaText: " Still connected.",
          });
          await form.text("Ready. Still connected.").waitFor();
          expect(await message.inputValue()).toBe("Keep this draft.");
          expect(await form.button("Send message").isDisabled()).toBe(true);
          await native.emit("quickchat:chat-event", { ...reply, state: "final" });
          await expect.poll(() => form.button("Send message").isDisabled()).toBe(false);
        },
        true,
      );
    },
  );
});
