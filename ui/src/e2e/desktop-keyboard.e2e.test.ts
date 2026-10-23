import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const asciiText = "Aa7!z?Bb8@x#Cc9$w%Dd0^v&Ee1*f(G)";
const suite = createControlUiE2eSuite({
  name: "desktop keyboard wire input",
  startServerBeforeBrowser: true,
});

const desktopObserve = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=synthetic-keyboard",
  expiresAtMs: 60_000,
  control: true,
};

async function openKeyboard(page: Page, beforeReady?: (panel: Locator) => Promise<void>) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["environments.list", "desktop.observe"],
    featureMethods: ["desktop.observe", "environments.list"],
    methodResponses: { "desktop.observe": desktopObserve },
  });
  await page.goto(`${suite.server.baseUrl}focus/desktop/control/source/gateway`);
  await gateway.waitForRequest("environments.list");
  const peer = await installScriptedRfbServer(page);
  await gateway.resolveDeferred("environments.list", {
    environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
  });
  const panel = page.locator("openclaw-desktop-panel");
  await gateway.waitForRequest("desktop.observe");
  await beforeReady?.(panel);
  await gateway.resolveDeferred("desktop.observe");
  await panel.locator(".desktop-surface canvas").waitFor();
  await expect.poll(peer.events).toEqual(["authenticated:1"]);
  await connectingStatus(panel).waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Keyboard", exact: true }).click();
  return { gateway, panel, peer, input: panel.locator(".desktop-keyboard-input") };
}

type ModifierRow = [string, string, string, number, string, number];
function makeModifier([platform, key, code, location, flag, keysym]: ModifierRow) {
  return { platform, key, code, location, flag, keysym };
}
const connectingStatus = (panel: Locator) =>
  panel.getByRole("status", { name: "Connecting to desktop…", exact: true });
const keyboardButton = (panel: Locator) =>
  panel.getByRole("button", { name: "Keyboard", exact: true });
async function expectDisabled(panel: Locator) {
  expect(
    await Promise.all([
      keyboardButton(panel).isDisabled(),
      panel.locator(".desktop-keyboard-input").isDisabled(),
    ]),
  ).toEqual([true, true]);
}
function dispatchInput(
  element: Element,
  edit: { text: string; inputType: string; value?: string },
) {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the desktop keyboard textarea");
  }
  if (edit.value === undefined) {
    element.setRangeText(edit.text, element.selectionStart, element.selectionEnd, "end");
  } else {
    element.value = edit.value;
  }
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: edit.inputType,
      data: edit.text || null,
    }),
  );
}

function keyPresses(keysyms: readonly number[]) {
  return keysyms.flatMap((keysym) => [
    { down: true, keysym },
    { down: false, keysym },
  ]);
}

suite.define(() => {
  it.each([
    { destination: "canvas", release: true },
    { destination: "toolbar", release: true },
    { destination: "toolbar", release: false },
  ])(
    "keeps Shift held across $destination focus and respects release=$release before paste",
    async ({ destination, release }) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { panel, peer, input } = await openKeyboard(page);
        await page.keyboard.down("Shift");
        const held = [{ down: true, keysym: 0xffe1 }];
        await expect.poll(peer.keyEvents).toEqual(held);
        await (
          destination === "canvas"
            ? panel.locator(".desktop-surface canvas")
            : panel.getByRole("combobox", { name: "Desktop size", exact: true })
        ).click();
        await expect.poll(peer.keyEvents).toEqual(held);
        if (release) {
          await page.keyboard.up("Shift");
        }
        if (destination === "toolbar") {
          await page.keyboard.press("Escape");
        }
        await keyboardButton(panel).click();
        await expect.poll(() => input.evaluate((element) => element.matches(":focus"))).toBe(true);
        await input.evaluate(dispatchInput, { text: "p", inputType: "insertFromPaste" });
        await expect
          .poll(peer.keyEvents)
          .toEqual([...keyPresses([0xffe1, 0x70]), ...(release ? [] : held)]);
        if (!release) {
          await page.keyboard.up("Shift");
          await expect
            .poll(peer.keyEvents)
            .toEqual([...keyPresses([0xffe1, 0x70]), ...keyPresses([0xffe1])]);
        }
      });
    },
  );

  it.each([
    makeModifier(["MacIntel", "Meta", "MetaLeft", 1, "metaKey", 0xffe9]),
    makeModifier(["MacIntel", "Meta", "MetaRight", 2, "metaKey", 0xffeb]),
    makeModifier(["Win32", "Control", "ControlLeft", 1, "ctrlKey", 0xffe3]),
    makeModifier(["Win32", "Control", "ControlRight", 2, "ctrlKey", 0xffe4]),
  ])(
    "keeps $code paste local on $platform and sends literal text without held modifiers",
    async (modifier) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await page.addInitScript((platform) => {
          Object.defineProperty(navigator, "platform", { value: platform });
        }, modifier.platform);
        const { peer, input } = await openKeyboard(page);
        const text = asciiText;
        const defaults = await input.evaluate(
          (element, paste) => {
            if (!(element instanceof HTMLTextAreaElement)) {
              throw new Error("Expected the desktop keyboard textarea");
            }
            const dispatch = (type: string, key: string, code: string, held = true) =>
              element.dispatchEvent(
                new KeyboardEvent(type, {
                  key,
                  code,
                  location: code === paste.modifier.code ? paste.modifier.location : 0,
                  [paste.modifier.flag]: held,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            dispatch("keydown", paste.modifier.key, paste.modifier.code);
            const allowed = dispatch("keydown", "v", "KeyV");
            // Supply synthetic browser paste input without reading or changing the OS clipboard.
            if (allowed) {
              element.setRangeText(paste.text, element.selectionStart, element.selectionEnd, "end");
              element.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertFromPaste",
                  data: paste.text,
                }),
              );
            }
            const released = dispatch("keyup", "v", "KeyV");
            dispatch("keydown", "a", "KeyA");
            dispatch("keyup", "a", "KeyA");
            dispatch("keyup", paste.modifier.key, paste.modifier.code, false);
            return { allowed, released };
          },
          { modifier, text },
        );
        expect(defaults).toEqual({ allowed: true, released: true });
        await expect
          .poll(peer.keyEvents)
          .toEqual([
            ...keyPresses([modifier.keysym]),
            ...keyPresses(Array.from(text, (character) => character.charCodeAt(0))),
            { down: true, keysym: modifier.keysym },
            ...keyPresses([0x61]),
            { down: false, keysym: modifier.keysym },
          ]);
      });
    },
  );

  it("accepts 32 pasted ASCII characters only after connected control and disables view-only input", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.setViewportSize({ width: 720, height: 540 });
      const { gateway, panel, peer, input } = await openKeyboard(page, async (connectingPanel) => {
        await connectingStatus(connectingPanel).waitFor();
        const keyboard = keyboardButton(connectingPanel);
        const pendingInput = connectingPanel.locator(".desktop-keyboard-input");
        const padding = await pendingInput.inputValue();
        const bounds = await keyboard.boundingBox();
        if (!bounds) {
          throw new Error("Expected the visible desktop Keyboard button");
        }
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.keyboard.insertText("early");
        expect(await pendingInput.inputValue()).toBe(padding);
        await expectDisabled(connectingPanel);
      });
      expect(await peer.keyEvents()).toEqual([]);
      const padding = await input.inputValue();
      const text = asciiText;
      const expected = keyPresses(Array.from(text, (character) => character.charCodeAt(0)));

      await page.keyboard.insertText(text);
      await expect.poll(peer.keyEvents).toEqual(expected);
      expect(await input.inputValue()).toBe(padding);

      await page.keyboard.insertText("Z");
      await page.keyboard.press("Backspace");
      await expect.poll(peer.keyEvents).toEqual([...expected, ...keyPresses([0x5a, 0xff08])]);

      await page.keyboard.down("Shift");
      const beforeHandoff = [...expected, ...keyPresses([0x5a, 0xff08])];
      await expect.poll(peer.keyEvents).toEqual([...beforeHandoff, { down: true, keysym: 0xffe1 }]);
      await gateway.setMethodResponse("desktop.observe", { ...desktopObserve, control: false });
      await gateway.deferNext("desktop.observe");
      await panel.getByRole("button", { name: "Switch to view only", exact: true }).click();
      await gateway.waitForRequest("desktop.observe", { after: 1 });
      const released = [...beforeHandoff, ...keyPresses([0xffe1])];
      await expect.poll(peer.keyEvents).toEqual(released);
      expect(await peer.events()).not.toContain("closed:1");
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(peer.events).toContain("authenticated:2");
      await expect.poll(peer.events).toContain("closed:1");
      await page.keyboard.up("Shift");
      await connectingStatus(panel).waitFor({ state: "hidden" });
      await expectDisabled(panel);
      await peer.disconnect("view-only reconnect");
      await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect.poll(peer.events).toContain("authenticated:3");
      await expect.poll(peer.events).toContain("closed:2");
      await connectingStatus(panel).waitFor({ state: "hidden" });
      await expectDisabled(panel);
      expect(await peer.keyEvents()).toEqual(released);
    });
  });

  it.each<[string, string, string, number[]]>([
    ["deletion", "", "deleteContentBackward", [0xff08]],
    ["replacement", "🦀", "insertReplacementText", [0xff08, 0x0101f980]],
  ])(
    "keeps supplementary characters intact during mobile %s",
    async (_name, replacement, inputType, keysyms) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { peer, input } = await openKeyboard(page);
        const padding = await input.inputValue();
        await page.keyboard.insertText("🦞");
        await expect.poll(peer.keyEvents).toEqual(keyPresses([0x0101f99e]));
        await input.evaluate(dispatchInput, {
          value: padding + replacement,
          inputType,
          text: replacement,
        });
        await expect.poll(peer.keyEvents).toEqual(keyPresses([0x0101f99e, ...keysyms]));
      });
    },
  );

  it.each<[string, string, number[]]>([
    ["BMP", "éΩ漢", [0x00e9, 0x07d9, 0x01006f22]],
    ["line endings", "a\r\nb\rc\nd", [0x61, 0xff0d, 0x62, 0xff0d, 0x63, 0xff0d, 0x64]],
    ["supplementary Unicode", "A🦞B", [0x41, 0x0101f99e, 0x42]],
  ])("emits balanced %s keysyms through real noVNC", async (_name, text, keysyms) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { peer } = await openKeyboard(page);
      await page.keyboard.insertText(text);
      await expect.poll(peer.keyEvents).toEqual(keyPresses(keysyms));
    });
  });
});
