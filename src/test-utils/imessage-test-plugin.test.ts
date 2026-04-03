import { afterEach, describe, expect, it } from "vitest";
import {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "../plugin-sdk/facade-runtime.js";
import { createIMessageTestPlugin } from "./imessage-test-plugin.js";

afterEach(() => {
  resetFacadeRuntimeStateForTest();
});

describe("createIMessageTestPlugin", () => {
  it("does not load the bundled iMessage facade by default", () => {
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    createIMessageTestPlugin();

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
  });
});
