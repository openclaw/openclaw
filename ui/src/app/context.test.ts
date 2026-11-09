import { afterEach, describe, expect, it } from "vitest";
import { useApplication } from "../lib/reactive/context.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import {
  createApplicationContextProvider,
  requestApplicationContext,
} from "../test-helpers/application-context.ts";
import { cleanupSolid } from "../test-helpers/solid-cleanup.ts";
import type { ApplicationContext } from "./context.ts";

const Consumer = defineSolidBridge(
  "test-application-context-consumer",
  () => {
    const context = useApplication();
    return context.basePath;
  },
  { properties: {} },
);

afterEach(() => {
  document.body.replaceChildren();
});

describe("application context consumption", () => {
  it("rebinds a retained consumer after its provider value changes while disconnected", async () => {
    const initialContext = { basePath: "/initial" } as ApplicationContext;
    const replacementContext = { basePath: "/replacement" } as ApplicationContext;
    const provider = createApplicationContextProvider(initialContext);
    const consumer = new Consumer.Element();

    document.body.append(provider);
    provider.append(consumer);
    await consumer.updateComplete;
    expect(consumer.textContent).toBe("/initial");

    consumer.remove();
    provider.setContext(replacementContext);
    provider.append(consumer);
    await consumer.updateComplete;

    expect(consumer.textContent).toBe("/replacement");
  });

  it("retires plain-DOM providers during Solid test cleanup", () => {
    const provider = createApplicationContextProvider({
      basePath: "/initial",
    } as ApplicationContext);
    const consumer = document.createElement("div");
    provider.append(consumer);
    const values: string[] = [];
    const receive = (context: ApplicationContext) => values.push(context.basePath);

    requestApplicationContext(consumer, receive);
    expect(values).toEqual(["/initial"]);

    cleanupSolid();
    requestApplicationContext(consumer, receive);
    expect(values).toEqual(["/initial"]);
  });
});
