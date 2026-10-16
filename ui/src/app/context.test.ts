import { afterEach, describe, expect, it } from "vitest";
import {
  createApplicationContextProvider,
  requestApplicationContext,
} from "../test-helpers/application-context.ts";
import type { ApplicationContext } from "./context.ts";

const CONSUMER_ELEMENT_NAME = "test-application-context-consumer";

class TestApplicationContextConsumer extends HTMLElement {
  context?: ApplicationContext;
  private unsubscribe?: () => void;

  connectedCallback() {
    requestApplicationContext(
      this,
      (context, unsubscribe) => {
        this.context = context;
        this.unsubscribe = unsubscribe;
      },
      true,
    );
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

if (!customElements.get(CONSUMER_ELEMENT_NAME)) {
  customElements.define(CONSUMER_ELEMENT_NAME, TestApplicationContextConsumer);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("application context consumption", () => {
  it("rebinds a retained consumer after its provider value changes while disconnected", () => {
    const initialContext = { basePath: "/initial" } as ApplicationContext;
    const replacementContext = { basePath: "/replacement" } as ApplicationContext;
    const provider = createApplicationContextProvider(initialContext);
    const consumer = document.createElement(
      CONSUMER_ELEMENT_NAME,
    ) as TestApplicationContextConsumer;

    document.body.append(provider);
    provider.append(consumer);
    expect(consumer.context).toBe(initialContext);

    consumer.remove();
    provider.setContext(replacementContext);
    provider.append(consumer);

    expect(consumer.context).toBe(replacementContext);
  });
});
