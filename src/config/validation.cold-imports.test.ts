// Guards config entrypoints against unnecessary cold imports.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";

describe("config cold imports", () => {
  it("preserves runtime exports without loading type-only config modules", async () => {
    const typeOnlyModuleImport = vi.fn();
    vi.doMock("./types.channels.js", () => {
      typeOnlyModuleImport();
      return {};
    });

    try {
      const runtime = await importFreshModule<typeof import("./types.js")>(
        import.meta.url,
        "./types.js?scope=config-runtime-exports",
      );
      expect(typeOnlyModuleImport).not.toHaveBeenCalled();

      const [models, secrets, tools] = await Promise.all([
        import("./types.models.js"),
        import("./types.secrets.js"),
        import("./types.tools.js"),
      ]);
      expect(runtime).toMatchObject({ ...models, ...secrets, ...tools });
    } finally {
      vi.doUnmock("./types.channels.js");
    }
  });
});
