import { describe, expect, it } from "vitest";
import { classifyControlUiRequest } from "./control-ui-routing.js";

describe("classifyControlUiRequest", () => {
  it("falls through non-read root requests for plugin webhooks", () => {
    const classified = classifyControlUiRequest({
      basePath: "",
      pathname: "/bluebubbles-webhook",
      search: "",
      method: "POST",
    });
    expect(classified).toEqual({ kind: "not-control-ui" });
  });

  it("returns not-found for legacy /ui routes when root-mounted", () => {
    const classified = classifyControlUiRequest({
      basePath: "",
      pathname: "/ui/settings",
      search: "",
      method: "GET",
    });
    expect(classified).toEqual({ kind: "not-found" });
  });

  it("falls through basePath non-read methods for plugin webhooks", () => {
    const classified = classifyControlUiRequest({
      basePath: "/openclaw",
      pathname: "/openclaw",
      search: "",
      method: "POST",
    });
    expect(classified).toEqual({ kind: "not-control-ui" });
  });

  it("falls through PUT/DELETE/PATCH/OPTIONS under basePath for plugin handlers", () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const classified = classifyControlUiRequest({
        basePath: "/openclaw",
        pathname: "/openclaw/webhook",
        search: "",
        method,
      });
      expect(classified, `${method} should fall through`).toEqual({ kind: "not-control-ui" });
    }
  });

  it("returns redirect for basePath entrypoint GET", () => {
    const classified = classifyControlUiRequest({
      basePath: "/openclaw",
      pathname: "/openclaw",
      search: "?foo=1",
      method: "GET",
    });
    expect(classified).toEqual({ kind: "redirect", location: "/openclaw/?foo=1" });
  });

  it("classifies basePath subroutes as control ui", () => {
    const classified = classifyControlUiRequest({
      basePath: "/openclaw",
      pathname: "/openclaw/chat",
      search: "",
      method: "HEAD",
    });
    expect(classified).toEqual({ kind: "serve" });
  });
});
