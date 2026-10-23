import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { resolveControlUiPaths } from "./browser.ts";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
});

describe("Control UI route and resource bases", () => {
  it("uses a configured Gateway mount for both routes and resources", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "/openclaw");

    expect(resolveControlUiPaths("/openclaw/new")).toEqual(["/openclaw", "/openclaw"]);
  });

  it("retains pathname inference when no Gateway mount is declared", () => {
    expect(resolveControlUiPaths("/portable/new")).toEqual(["/portable", "/portable"]);
  });

  it("keeps an explicit root mount for a cold trailing-slash plugin link", () => {
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "");

    expect(resolveControlUiPaths("/reports/")).toEqual(["", ""]);
  });

  it.each(["/__openclaw__", "/portable"])(
    "keeps inferred %s routes separate from an explicit root resource mount",
    (basePath) => {
      document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "");

      expect(resolveControlUiPaths(`${basePath}/new`)).toEqual([basePath, ""]);
    },
  );
});
