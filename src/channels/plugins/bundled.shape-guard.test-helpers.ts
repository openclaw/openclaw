import { createRequire } from "node:module";
import { vi } from "vitest";

const requireModule = createRequire(import.meta.url);

export function mockChannelPluginModuleLoader(): void {
  vi.doMock("./module-loader.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./module-loader.js")>();
    return {
      ...actual,
      loadChannelPluginModule: ({ modulePath }: { modulePath: string }) =>
        requireModule(modulePath),
    };
  });
}
