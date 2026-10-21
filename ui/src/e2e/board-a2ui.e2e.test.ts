import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import type { Frame } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetSandboxPath } from "../../../src/gateway/board-sandbox.js";
import { a2uiV09Corpus } from "../test-helpers/a2ui-v09-corpus.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeBoardTestServer, createBoardE2eSuite } from "./board-browser.test-support.ts";

const sessionKey = "agent:main:board-a2ui";
const bundleDirectory = path.resolve(
  process.env.OPENCLAW_A2UI_BUNDLE_DIR?.trim() || "extensions/canvas/src/host/a2ui",
);
const bundleFiles = {
  "v0.8": "a2ui.bundle.js",
  "v0.9": "a2ui-v0.9.bundle.js",
} as const;
const basicCatalog = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

let rendererServer: HttpServer;
let rendererOrigin: string;
type Protocol = keyof typeof bundleFiles;

function textComponent(version: Protocol, id: string, text: string) {
  return version === "v0.8"
    ? { id, component: { Text: { text: { literalString: text } } } }
    : { id, component: "Text", text };
}

function applyMessages(frame: Frame, messages: unknown[]) {
  return frame.evaluate(
    (updates) => Reflect.get(globalThis, "openclawA2UI").applyMessages(updates),
    messages,
  );
}

function refreshButton(context: Record<string, string> = {}) {
  return {
    id: "action",
    component: "Button",
    child: "action-label",
    variant: "primary",
    action: { event: { name: "refresh", context } },
  };
}

function updateComponents(version: Protocol, components: unknown[]) {
  const update = { surfaceId: "main", components };
  return version === "v0.8" ? { surfaceUpdate: update } : { version, updateComponents: update };
}

function buildInitialMessages(version: Protocol) {
  const components = [
    version === "v0.8"
      ? { id: "root", component: { Column: { children: { explicitList: ["title", "action"] } } } }
      : { id: "root", component: "Column", children: ["title", "action"] },
    textComponent(version, "title", "A2UI board widget"),
    version === "v0.8"
      ? {
          id: "action",
          component: {
            Button: { child: "action-label", action: { name: "refresh", context: [] } },
          },
        }
      : refreshButton(),
    textComponent(version, "action-label", "Refresh data"),
  ];
  const update = updateComponents(version, components);
  return version === "v0.8"
    ? [update, { beginRendering: { surfaceId: "main", root: "root" } }]
    : [{ version, createSurface: { surfaceId: "main", catalogId: basicCatalog } }, update];
}

const suite = createBoardE2eSuite("Control UI dashboard A2UI", {
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  beforeStart: async () => {
    if (!process.env.OPENCLAW_A2UI_BUNDLE_DIR?.trim()) {
      execFileSync(process.execPath, ["--import", "./scripts/tsx.mjs", "scripts/bundle-a2ui.mts"], {
        cwd: process.cwd(),
        stdio: "inherit",
      });
    }
    const rendererBundles = new Map<string, Buffer>(
      await Promise.all(
        Object.values(bundleFiles).map(
          async (file) => [file, await readFile(path.join(bundleDirectory, file))] as const,
        ),
      ),
    );
    rendererServer = createServer((request, response) => {
      const bundle = rendererBundles.get(
        path.posix.basename(new URL(request.url ?? "/", "http://localhost").pathname),
      );
      response.writeHead(
        bundle ? 200 : 404,
        bundle ? { "Content-Type": "text/javascript; charset=utf-8" } : {},
      );
      response.end(bundle ?? "not found");
    });
    rendererServer.listen(0, "127.0.0.1");
    await once(rendererServer, "listening");
    const rendererAddress = rendererServer.address();
    if (!rendererAddress || typeof rendererAddress === "string") {
      throw new Error("A2UI renderer server did not bind");
    }
    rendererOrigin = `http://127.0.0.1:${rendererAddress.port}`;
  },
  afterSandboxClose: () => closeBoardTestServer(rendererServer),
});
suite.define(() => {
  it("renders the v0.9 catalog and keeps bound inputs, templates, validation, and actions live", async () => {
    const page = await suite.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate((messages) => {
      const actions: unknown[] = [];
      Reflect.set(globalThis, "catalogActions", actions);
      Reflect.set(globalThis, "openclawA2UIBoot", { messages });
      Reflect.set(globalThis, "openclaw", {
        state: {
          emit: async (action: unknown) => {
            actions.push(action);
          },
        },
      });
      document.body.append(document.createElement("openclaw-a2ui-host"));
    }, a2uiV09Corpus());
    await page.addScriptTag({
      path: path.join(bundleDirectory, bundleFiles["v0.9"]),
      type: "module",
    });
    await page.getByRole("heading", { name: "Canvas catalog" }).waitFor();
    expect(await page.evaluate(() => Reflect.get(globalThis, "litHtmlVersions"))).toBeUndefined();
    await expect.poll(() => page.locator("#intro strong").textContent()).toBe("live");
    expect(await page.locator("#icon svg path").getAttribute("d")).toBe(
      "M3 12l6 6L21 6l-2-2L9 14l-4-4z",
    );
    await page.getByAltText("Synthetic landscape").waitFor();
    expect(await page.locator("#video video").getAttribute("controls")).toBe("");
    expect(await page.locator("#audio audio").getAttribute("controls")).toBe("");
    await page.locator("#divider hr").waitFor();
    await expect
      .poll(async () =>
        (await page.locator("#items .a2ui-text").allTextContents()).map((text) => text.trim()),
      )
      .toEqual(["First item", "Second item"]);
    await page.getByLabel("Name", { exact: true }).fill("Grace");
    await expect.poll(() => page.locator("#echo p").textContent()).toBe("Grace");
    await page.getByLabel("Notifications").uncheck();
    await page.getByLabel("Capacity").press("End");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-21");
    await page.getByLabel("Time", { exact: true }).fill("15:45");
    await page.getByRole("button", { name: "Beta", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    expect(await page.evaluate(() => Reflect.get(globalThis, "catalogActions"))).toMatchObject([
      {
        eventType: "a2ui.action",
        action: {
          name: "save",
          sourceComponentId: "submit",
          surfaceId: "main",
          context: {
            name: "Grace",
            enabled: false,
            amount: 100,
            when: "2026-10-21T15:45:00",
            choices: ["a", "b"],
          },
        },
      },
    ]);

    await page.getByRole("tab", { name: "Notes", exact: true }).click();
    await expect.poll(() => page.locator("#notes p").textContent()).toBe("Second tab content");
    await page.getByRole("tab", { name: "Notes", exact: true }).press("ArrowLeft");
    await expect
      .poll(async () =>
        (await page.locator("#items .a2ui-text").allTextContents()).map((text) => text.trim()),
      )
      .toEqual(["First item", "Second item"]);
    await page.getByRole("button", { name: "Open details" }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
      .toContain("Details in a dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(
      await page
        .getByRole("button", { name: "Open details" })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);

    await applyMessages(page.mainFrame(), [
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "main", path: "/name", value: "Server update" },
      },
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "main",
          path: "/items",
          value: [{ title: "Replacement item" }],
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "main",
          components: [
            {
              id: "submit",
              component: "Button",
              child: "submit-label",
              action: { event: { name: "save" } },
              checks: [{ condition: false, message: "Complete the form" }],
            },
            {
              id: "intro",
              component: "Text",
              text: "**Safe** <img src=x onerror=alert(1)> [bad](javascript:alert(1))",
            },
            { id: "amount", component: "Slider", label: "Capacity", min: 0, max: 1, value: 0.5 },
            {
              id: "when",
              component: "DateTimeInput",
              value: { path: "/when" },
              enableDate: true,
              enableTime: true,
              min: "2026-10-20T09:00:00",
              max: "2026-10-22T17:00:00",
            },
          ],
        },
      },
    ]);
    await expect
      .poll(() => page.getByLabel("Name", { exact: true }).inputValue())
      .toBe("Server update");
    await expect.poll(() => page.locator("#items p").textContent()).toBe("Replacement item");
    await expect
      .poll(() => page.getByRole("button", { name: "Save changes" }).isDisabled())
      .toBe(true);
    await expect.poll(() => page.locator("#intro strong").textContent()).toBe("Safe");
    expect(await page.locator("#intro img, #intro a, #intro script").count()).toBe(0);
    await expect.poll(() => page.getByLabel("Capacity").inputValue()).toBe("0.5");
    expect(
      await page
        .getByLabel("Capacity")
        .evaluate((input) => input instanceof HTMLInputElement && input.validity.valid),
    ).toBe(true);
    expect(await page.getByLabel("Date", { exact: true }).getAttribute("min")).toBe("2026-10-20");
    expect(await page.getByLabel("Date", { exact: true }).getAttribute("max")).toBe("2026-10-22");
    expect(await page.getByLabel("Time", { exact: true }).getAttribute("min")).toBeNull();
    await page.getByLabel("Date", { exact: true }).fill("2026-10-20");
    await expect
      .poll(() => page.getByLabel("Time", { exact: true }).getAttribute("min"))
      .toBe("09:00");
    await page.getByLabel("Date", { exact: true }).evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Expected native date input");
      }
      input.value = "2026-10-21";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await applyMessages(page.mainFrame(), [
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "main",
          components: [
            {
              id: "when",
              component: "DateTimeInput",
              label: "Calendar refreshed",
              value: { path: "/when" },
              enableDate: true,
              enableTime: true,
              min: "2026-10-19T09:00:00",
              max: "2026-10-22T17:00:00",
            },
          ],
        },
      },
    ]);
    await page.getByText("Calendar refreshed", { exact: true }).waitFor();
    expect(await page.getByLabel("Date", { exact: true }).inputValue()).toBe("2026-10-21");
    await applyMessages(page.mainFrame(), [
      updateComponents("v0.9", [
        { id: "root", component: "Column", children: ["weighted", "action"] },
        { id: "weighted", component: "Row", children: ["left", "right"] },
        { ...textComponent("v0.9", "left", "Left"), weight: 1 },
        { ...textComponent("v0.9", "right", "Right"), weight: 2 },
        refreshButton(),
        textComponent("v0.9", "action-label", "Themed action"),
      ]),
    ]);
    await expect
      .poll(async () => {
        const left = await page.locator("#left .a2ui-text").boundingBox();
        const right = await page.locator("#right .a2ui-text").boundingBox();
        return left && right ? right.width / left.width : 0;
      })
      .toBeCloseTo(2, 2);
    await page.emulateMedia({ colorScheme: "light" });
    const themedAction = page.getByRole("button", { name: "Themed action" });
    await themedAction.hover();
    expect(
      await themedAction.evaluate((button) => {
        const sample = document.createElement("span");
        sample.style.backgroundColor = "color-mix(in oklab, #197a55 85%, black)";
        document.body.append(sample);
        const expected = getComputedStyle(sample).backgroundColor;
        sample.remove();
        return getComputedStyle(button).backgroundColor === expected;
      }),
    ).toBe(true);
    await page.evaluate(() => Reflect.get(globalThis, "openclawA2UI").reset());
    await expect.poll(() => page.locator("a2ui-surface").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("sends each v0.8 action once after the host reconnects", async () => {
    const page = await suite.newPage();
    await page.addScriptTag({
      path: path.join(bundleDirectory, bundleFiles["v0.8"]),
      type: "module",
    });
    const result = await page.evaluate(async () => {
      await customElements.whenDefined("openclaw-a2ui-host");
      const emitted: unknown[] = [];
      Reflect.set(globalThis, "openclaw", {
        state: {
          emit(payload: unknown) {
            emitted.push(payload);
            return Promise.resolve();
          },
        },
      });
      const host = document.createElement("openclaw-a2ui-host");
      const sendAction = () =>
        host.dispatchEvent(
          new CustomEvent("a2uiaction", {
            detail: {
              eventType: "a2ui.action",
              sourceComponentId: "refresh-button",
              action: { name: "refresh" },
            },
          }),
        );
      document.body.append(host);
      sendAction();
      const connectedCount = emitted.length;
      emitted.length = 0;
      host.remove();
      document.body.append(host);
      sendAction();
      host.remove();
      return { connectedCount, reconnected: emitted };
    });
    expect(result).toMatchObject({
      connectedCount: 1,
      reconnected: [
        {
          eventType: "a2ui.action",
          action: { name: "refresh", surfaceId: "main", sourceComponentId: "refresh-button" },
        },
      ],
    });
  });

  it("keeps v0.8 bindings, templated rows, and actions live in the rendered catalog", async () => {
    const page = await suite.newPage();
    await page.addScriptTag({
      path: path.join(bundleDirectory, bundleFiles["v0.8"]),
      type: "module",
    });
    await page.evaluate(() => {
      Reflect.set(globalThis, "canvasActions", []);
      Reflect.set(globalThis, "canvasValidation", []);
      Reflect.set(globalThis, "openclaw", {
        state: {
          emit: async (action: unknown) => {
            Reflect.get(globalThis, "canvasActions").push(action);
          },
        },
      });
      const host = document.createElement("openclaw-a2ui-host");
      host.style.width = "300px";
      host.addEventListener("a2ui-validation-input", (event) => {
        Reflect.get(globalThis, "canvasValidation").push(Reflect.get(event, "detail"));
      });
      document.body.append(host);
      Reflect.get(globalThis, "openclawA2UI").applyMessages([
        {
          surfaceUpdate: {
            surfaceId: "main",
            components: [
              {
                id: "root",
                component: {
                  Column: {
                    children: {
                      explicitList: [
                        "field",
                        "long-text",
                        "unsafe-pattern",
                        "mirror",
                        "list",
                        "choice",
                        "date",
                        "time",
                        "preview-list",
                        "rule",
                        "progress",
                        "save",
                      ],
                    },
                  },
                },
              },
              {
                id: "field",
                component: {
                  TextField: { label: { literalString: "Name" }, text: { path: "/name" } },
                },
              },
              { id: "mirror", component: { Text: { text: { path: "/name" } } } },
              {
                id: "long-text",
                component: {
                  TextField: {
                    label: { literalString: "Uppercase details" },
                    text: { path: "/details" },
                    textFieldType: "longText",
                    validationRegexp: "[A-Z]+",
                  },
                },
              },
              {
                id: "unsafe-pattern",
                component: {
                  TextField: {
                    label: { literalString: "Unrestricted details" },
                    text: { path: "/unrestricted" },
                    validationRegexp: "^(a+)+$",
                  },
                },
              },
              {
                id: "preview-list",
                component: {
                  List: {
                    direction: "horizontal",
                    children: { explicitList: ["card-a", "card-b", "card-c"] },
                  },
                },
              },
              ...["a", "b", "c"].flatMap((key) => [
                { id: `card-${key}`, component: { Card: { child: `card-text-${key}` } } },
                {
                  id: `card-text-${key}`,
                  component: {
                    Text: {
                      text: {
                        literalString:
                          "Synthetic content keeps each card readable in a narrow horizontal list.",
                      },
                    },
                  },
                },
              ]),
              { id: "rule", component: { Divider: { thickness: 4, color: "#ff0000" } } },
              {
                id: "progress",
                component: {
                  Slider: {
                    label: { literalString: "Completion" },
                    value: { path: "/progress" },
                    minValue: 0,
                    maxValue: 100,
                  },
                },
              },
              {
                id: "date",
                component: { DateTimeInput: { value: { path: "/date" }, enableTime: false } },
              },
              {
                id: "time",
                component: { DateTimeInput: { value: { path: "/time" }, enableDate: false } },
              },
              {
                id: "list",
                component: {
                  List: { children: { template: { componentId: "row", dataBinding: "/items" } } },
                },
              },
              {
                id: "row",
                component: { Column: { children: { explicitList: ["row-label", "choose"] } } },
              },
              { id: "row-label", component: { Text: { text: { path: "label" } } } },
              {
                id: "choose",
                component: {
                  Button: {
                    child: "choose-label",
                    action: {
                      name: "choose",
                      context: [{ key: "label", value: { path: "label" } }],
                    },
                  },
                },
              },
              {
                id: "choose-label",
                component: { Text: { text: { literalString: "Choose row" } } },
              },
              {
                id: "choice",
                component: {
                  MultipleChoice: {
                    selections: { path: "/selected" },
                    variant: "chips",
                    options: [{ label: { literalString: "Alpha" }, value: "alpha" }],
                  },
                },
              },
              {
                id: "save",
                component: {
                  Button: {
                    child: "save-label",
                    action: {
                      name: "save",
                      context: ["name", "date", "time", "details", "unrestricted", "progress"].map(
                        (key) => ({ key, value: { path: `/${key}` } }),
                      ),
                    },
                  },
                },
              },
              { id: "save-label", component: { Text: { text: { literalString: "Save" } } } },
            ],
          },
        },
        {
          dataModelUpdate: {
            surfaceId: "main",
            contents: [
              { key: "name", valueString: "Initial" },
              { key: "date", valueString: "2026-10-15" },
              { key: "time", valueString: "12:30" },
              { key: "details", valueString: "" },
              { key: "unrestricted", valueString: "" },
              { key: "progress", valueNumber: 37 },
              { key: "selected", valueString: '["alpha"]' },
              {
                key: "items",
                valueMap: [
                  { key: "first", valueMap: [{ key: "label", valueString: "First row" }] },
                ],
              },
            ],
          },
        },
        { beginRendering: { surfaceId: "main", root: "root" } },
      ]);
    });
    await page.getByText("First row", { exact: true }).waitFor();
    await page.locator('input[type="date"]').fill("2026-10-16");
    await page.locator('input[type="time"]').fill("13:30");
    const details = page.getByRole("textbox", { name: "Uppercase details", exact: true });
    await details.fill("lowercase");
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, "canvasValidation").at(-1)))
      .toMatchObject({ componentId: "long-text", value: "lowercase", valid: false });
    await details.fill("ABC");
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, "canvasValidation").at(-1)))
      .toMatchObject({ componentId: "long-text", value: "ABC", valid: true });
    const unrestricted = page.getByRole("textbox", { name: "Unrestricted details", exact: true });
    expect(await unrestricted.getAttribute("pattern")).toBeNull();
    await unrestricted.fill("arbitrary");
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, "canvasValidation").at(-1)))
      .toMatchObject({ componentId: "unsafe-pattern", value: "arbitrary", valid: true });
    const horizontalList = page.locator("#preview-list > section");
    expect(await horizontalList.evaluate((element) => element.scrollWidth)).toBeGreaterThan(300);
    expect(
      await horizontalList.evaluate((element) => {
        element.scrollLeft = 100;
        return element.scrollLeft;
      }),
    ).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.locator("#rule hr").evaluate((element) => {
          const style = getComputedStyle(element);
          return { height: style.height, color: style.backgroundColor };
        }),
      )
      .toEqual({ height: "4px", color: "rgb(255, 0, 0)" });
    await expect.poll(() => page.locator("#progress output").textContent()).toBe("37");
    await page.getByRole("slider", { name: "Completion", exact: true }).press("ArrowRight");
    await expect.poll(() => page.locator("#progress output").textContent()).toBe("38");
    const choice = page.getByRole("button", { name: "Alpha" });
    await choice.click();
    await expect.poll(() => choice.getAttribute("aria-pressed")).toBe("false");
    await choice.click();
    await expect.poll(() => choice.getAttribute("aria-pressed")).toBe("true");
    const field = page.getByRole("textbox", { name: "Name", exact: true });
    await field.fill("Edited");
    await page.getByText("Edited", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, "canvasActions")))
      .toMatchObject([
        {
          eventType: "a2ui.action",
          action: {
            name: "save",
            context: {
              name: "Edited",
              date: "2026-10-16",
              time: "13:30",
              details: "ABC",
              unrestricted: "arbitrary",
              progress: 38,
            },
          },
        },
      ]);
    await page.getByRole("button", { name: "Choose row", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, "canvasActions")))
      .toMatchObject([
        { action: { name: "save" } },
        { action: { name: "choose", context: { label: "First row" } } },
      ]);
    const retained = await field.elementHandle();
    await page.evaluate(() =>
      Reflect.get(globalThis, "openclawA2UI").applyMessages([
        {
          dataModelUpdate: {
            surfaceId: "main",
            path: "/items",
            contents: [{ key: "second", valueMap: [{ key: "label", valueString: "Second row" }] }],
          },
        },
      ]),
    );
    await page.getByText("Second row", { exact: true }).waitFor();
    expect(await field.evaluate((element, previous) => element === previous, retained)).toBe(true);
    expect(await field.inputValue()).toBe("Edited");
    await page.getByText("Updated: choose", { exact: true }).waitFor();
    await retained?.dispose();
  });

  for (const { version, colorScheme, rejectsAction, name } of [
    ...(["v0.8", "v0.9"] as const).flatMap((protocol) =>
      (["dark", "light"] as const).map((theme) => ({
        version: protocol,
        colorScheme: theme,
        rejectsAction: false,
        name: `renders a ${protocol} widget with the ${theme} scrollbar theme`,
      })),
    ),
    {
      version: "v0.9" as const,
      colorScheme: "light" as const,
      rejectsAction: true,
      name: "shows rejected v0.9 actions and clears the widget on reset",
    },
  ]) {
    it(name, async () => {
      const page = await suite.newPage({
        colorScheme,
        permissions: ["local-network-access"],
        viewport: { width: 1280, height: 800 },
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (pageErrors.length < 8) {
          pageErrors.push(error.message.slice(0, 512));
        }
      });
      const origin = new URL(suite.baseUrl).origin;
      const rendererUrl = `${rendererOrigin}/__openclaw__/cap/canvas-proof/__openclaw__/a2ui/${bundleFiles[version]}`;
      const messages = buildInitialMessages(version);
      const boot = JSON.stringify({ messages, actionTier: "state" }).replaceAll("<", "\\u003c");
      const documentHtml = buildWidgetDocument(
        "A2UI controls",
        `<script>globalThis.openclawA2UIBoot=${boot};</script><style>html,body{height:100%;background:var(--surface)}body{min-height:2400px}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host><script src="${rendererUrl}"></script>`,
        { scriptOrigins: [rendererOrigin] },
      );
      const frameUrl = `${origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/a2ui-controls/index.html?bt=ticket`;
      await page.route("**/__openclaw__/board/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: documentHtml }),
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.event", "board.get", "chat.metadata", "chat.startup"],
        methodResponses: {
          "board.get": {
            sessionKey,
            revision: 1,
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
            widgets: [
              {
                name: "a2ui-controls",
                tabId: "main",
                title: "A2UI controls",
                contentKind: "plugin",
                pluginKind: "canvas:a2ui",
                kindLabel: "A2UI",
                sizeW: 8,
                sizeH: 5,
                heightMode: "fixed",
                position: 0,
                grantState: "none",
                revision: 1,
                instanceId: "a2ui-instance",
                frameUrl,
                viewTicket: "ticket",
                viewTicketTtlMs: 1_200_000,
                viewGeneration: "0123456789abcdef0123456789abcdef",
                sandboxUrl: buildBoardWidgetSandboxPath({
                  grantState: "none",
                  resourceOrigins: [rendererOrigin],
                }),
                sandboxPort: suite.sandboxPort,
              },
            ],
          },
          "board.event": { ok: true, appended: true },
        },
      });

      await suite.openDashboard(page, sessionKey);
      const outer = page.locator(".board-widget__frame");
      await outer.waitFor();
      const outerFrame = await outer.elementHandle().then((handle) => handle?.contentFrame());
      await expect
        .poll(
          () =>
            outerFrame
              ?.childFrames()[0]
              ?.evaluate(() =>
                Boolean(
                  customElements.get("openclaw-a2ui-host") &&
                  Reflect.get(globalThis, "openclawA2UI"),
                ),
              )
              .catch(() => false) ?? false,
          { timeout: 30_000 },
        )
        .toBe(true);
      const widgetFrame = outerFrame!.childFrames()[0]!;
      await widgetFrame.getByText("A2UI board widget").waitFor();
      await expect
        .poll(() => outer.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(await outer.getAttribute("inert")).toBeNull();
      if (rejectsAction) {
        await applyMessages(widgetFrame, [
          updateComponents("v0.9", [refreshButton({ diagnostic: "x".repeat(8193) })]),
        ]);
        await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
        await expect
          .poll(() => widgetFrame.getByRole("alert").allTextContents())
          .toEqual(["widget state payload exceeds 8192 UTF-8 bytes"]);
        expect(await widgetFrame.getByRole("alert").isVisible()).toBe(true);
        expect(await gateway.getRequests("board.event")).toHaveLength(0);
        expect(pageErrors).toEqual([]);

        await widgetFrame.evaluate(() => Reflect.get(globalThis, "openclawA2UI").reset());
        await expect.poll(() => widgetFrame.getByRole("alert").count()).toBe(0);
        await expect.poll(() => widgetFrame.locator("a2ui-surface").count()).toBe(0);
        await applyMessages(widgetFrame, messages);
        await widgetFrame.getByText("A2UI board widget").waitFor();
      }
      await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
      await expect.poll(async () => (await gateway.getRequests("board.event")).length).toBe(1);
      expect((await gateway.getRequests("board.event"))[0]?.params).toMatchObject({
        ticket: "ticket",
        payload: {
          eventType: "a2ui.action",
          action: { name: "refresh", surfaceId: "main", sourceComponentId: "action" },
        },
      });
      if (rejectsAction) {
        expect(await widgetFrame.getByRole("alert").count()).toBe(0);
        expect(pageErrors).toEqual([]);
        return;
      }
      const surface = await widgetFrame.locator("a2ui-surface").elementHandle();
      expect(surface).not.toBeNull();
      await applyMessages(widgetFrame, [
        updateComponents(version, [textComponent(version, "title", "A2UI board widget updated")]),
      ]);
      await widgetFrame.getByText("A2UI board widget updated", { exact: true }).waitFor();
      expect(
        await widgetFrame
          .locator("a2ui-surface")
          .evaluate((element, previousSurface) => element === previousSurface, surface),
      ).toBe(true);
      await surface?.dispose();
      await page.mouse.move(40, 40);

      const scrollbar = await widgetFrame.evaluate(() => {
        const root = document.documentElement;
        const probe = document.createElement("div");
        probe.style.background = "var(--scrollbar-thumb)";
        document.body.append(probe);
        const expectedThumb = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--scrollbar-thumb-hover)";
        const expectedThumbHover = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const styles = getComputedStyle(root);
        return {
          background: getComputedStyle(root, "::-webkit-scrollbar").backgroundColor,
          colorScheme: styles.colorScheme,
          expectedBackground: getComputedStyle(document.body).backgroundColor,
          expectedThumb,
          expectedThumbHover,
          ratio: root.clientHeight / root.scrollHeight,
          size: styles.getPropertyValue("--scrollbar-size"),
          thumbBackground: getComputedStyle(root, "::-webkit-scrollbar-thumb").backgroundColor,
          trackBackground: getComputedStyle(root, "::-webkit-scrollbar-track").backgroundColor,
          width: getComputedStyle(root, "::-webkit-scrollbar").width,
        };
      });
      expect(scrollbar).toMatchObject({
        colorScheme,
        expectedBackground: expect.any(String),
        expectedThumb: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        expectedThumbHover: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        size: "12px",
        trackBackground: "rgba(0, 0, 0, 0)",
        width: "12px",
      });
      expect(scrollbar.background).toBe(scrollbar.expectedBackground);
      expect([scrollbar.expectedThumb, scrollbar.expectedThumbHover]).toContain(
        scrollbar.thumbBackground,
      );
      expect(scrollbar.ratio).toBeLessThan(0.2);
      expect(pageErrors).toEqual([]);
    });
  }
});
