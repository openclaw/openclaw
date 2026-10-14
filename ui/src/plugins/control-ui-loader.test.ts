import { expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { initializeControlUiPlugin } from "./control-ui-loader.ts";
import { type ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

it.each(["load", "error", "abort"] as const)(
  "fetches assets concurrently and gates activation on CSS %s",
  async (result) => {
    const prefix = "/__openclaw__/plugins/control-ui/fixture/one/";
    const entryUrl = new URL(`${prefix}${result}.js`, window.location.href).href;
    const activate = vi.fn();
    const evaluated = vi.fn();
    vi.doMock(entryUrl, () => {
      evaluated();
      return { default: { id: "fixture", activate } };
    });
    const client = createTestGatewayClient(async () => ({}));
    const context = {
      config: createApplicationConfigCapability({ resourceBasePath: "" }),
      resourceBasePath: "",
      gateway: {
        snapshot: { phase: "connected", client },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
    } as unknown as ApplicationContext;
    const runtime = new ControlUiPluginRuntime(() => context);
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor: {
        pluginId: "fixture",
        name: "Fixture",
        revision: "one",
        entryUrl,
        styles: [`${prefix}first.css`, `${prefix}second.css`],
      },
      client,
      abort: new AbortController(),
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        accessories: new Map(),
        widgets: new Map(),
        replacements: new Map(),
      },
      selections: new Map(),
    };
    const styles: HTMLLinkElement[] = [];
    const dispose = () => {
      owner.abort.abort();
      owner.disposers.forEach((stop) => stop());
    };
    runtime.start();
    const pending = initializeControlUiPlugin(() => context, runtime, owner, styles, dispose);
    const outcome = pending.catch(() => undefined);
    try {
      const [firstStyle, secondStyle] = styles;
      if (!firstStyle || !secondStyle) {
        throw new Error("Both stylesheet requests must start before CSS settles.");
      }
      await vi.dynamicImportSettled();
      expect(evaluated).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      secondStyle.dispatchEvent(new Event("load"));
      expect(activate).not.toHaveBeenCalled();
      if (result === "abort") {
        owner.abort.abort();
      } else {
        firstStyle.dispatchEvent(new Event(result));
      }
      if (result === "load") {
        expect(await pending).toBe(owner);
        expect(activate).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(
          result === "error" ? "Could not load plugin stylesheet" : "Plugin UI activation ended",
        );
        expect(activate).not.toHaveBeenCalled();
      }
      expect(styles.map((style) => style.media)).toEqual(["not all", "not all"]);
    } finally {
      dispose();
      runtime.dispose();
      await outcome;
      vi.doUnmock(entryUrl);
    }
  },
);
