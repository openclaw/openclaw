import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

describe("gateway.fileRoots", () => {
  it("accepts named read-only roots without transforming their path", () => {
    const parsed = GatewayConfigSchema.safeParse({
      fileRoots: {
        obsidian: { label: "Obsidian Vault", path: "/srv/notes", readOnly: true },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fileRoots?.obsidian).toEqual({
      label: "Obsidian Vault",
      path: "/srv/notes",
      readOnly: true,
    });
  });

  it("preserves significant boundary whitespace in a nonblank root path", () => {
    const path = "/srv/notes ";
    const parsed = GatewayConfigSchema.safeParse({
      fileRoots: {
        notes: { label: "Notes", path },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fileRoots?.notes.path).toBe(path);
  });

  it.each(["Obsidian", "obsidian.root", "obsidian root", "1vault"])(
    "rejects invalid root id %s",
    (id) => {
      expect(
        GatewayConfigSchema.safeParse({
          fileRoots: { [id]: { label: "Notes", path: "/srv/notes" } },
        }).success,
      ).toBe(false);
    },
  );

  it("does not accept a writable root declaration yet", () => {
    expect(
      GatewayConfigSchema.safeParse({
        fileRoots: { notes: { label: "Notes", path: "/srv/notes", readOnly: false } },
      }).success,
    ).toBe(false);
  });
});
