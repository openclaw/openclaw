import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

describe("getDefaultMediaLocalRoots", () => {
  it("includes state workspaces for sandbox-hosted agent attachments", () => {
    const roots = getDefaultMediaLocalRoots();
    expect(roots).toContain(path.join(resolveStateDir(), "workspaces"));
  });
});
