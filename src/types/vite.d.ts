declare module "vite" {
  type ViteConfig = Record<string, unknown>;
  export function defineConfig(config: ViteConfig | (() => ViteConfig)): ViteConfig;
}

declare module "vitest/config" {
  type VitestConfig = Record<string, unknown>;
  export function defineConfig(config: VitestConfig): VitestConfig;
}

declare module "@vitest/browser-playwright" {
  export function playwright(): unknown;
}
