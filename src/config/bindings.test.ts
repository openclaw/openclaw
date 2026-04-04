import { describe, expect, it } from "vitest";
import {
  isRouteBinding,
  isAcpBinding,
  listConfiguredBindings,
  listRouteBindings,
  listAcpBindings,
} from "./bindings.js";

describe("isRouteBinding", () => {
  it("returns true for route type", () => {
    expect(isRouteBinding({ type: "route", match: {} })).toBe(true);
    expect(isRouteBinding({ type: "Route" } as any)).toBe(true);
  });

  it("returns false for acp type", () => {
    expect(isRouteBinding({ type: "acp" })).toBe(false);
  });
});

describe("isAcpBinding", () => {
  it("returns true for acp type", () => {
    expect(isAcpBinding({ type: "acp" })).toBe(true);
    expect(isAcpBinding({ type: "ACP" } as any)).toBe(true);
  });

  it("returns false for route type", () => {
    expect(isAcpBinding({ type: "route" })).toBe(false);
  });
});

describe("listConfiguredBindings", () => {
  it("returns empty array for undefined bindings", () => {
    expect(listConfiguredBindings({} as any)).toEqual([]);
  });

  it("returns array as-is", () => {
    const bindings = [{ type: "route", match: {} }];
    expect(listConfiguredBindings({ bindings } as any)).toEqual(bindings);
  });

  it("returns empty for non-array bindings", () => {
    expect(listConfiguredBindings({ bindings: "invalid" } as any)).toEqual([]);
  });
});

describe("listRouteBindings", () => {
  it("filters route bindings", () => {
    const cfg = {
      bindings: [
        { type: "route", match: {} },
        { type: "acp" },
        { type: "route", match: { channel: "telegram" } },
      ],
    } as any;
    const routes = listRouteBindings(cfg);
    expect(routes).toHaveLength(2);
    expect(routes.every(r => r.type === "route")).toBe(true);
  });
});

describe("listAcpBindings", () => {
  it("filters acp bindings", () => {
    const cfg = {
      bindings: [
        { type: "route", match: {} },
        { type: "acp" },
        { type: "acp", agentId: "codex" },
      ],
    } as any;
    const acps = listAcpBindings(cfg);
    expect(acps).toHaveLength(2);
    expect(acps.every(a => a.type === "acp")).toBe(true);
  });
});
