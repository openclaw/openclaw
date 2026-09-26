export type PluginScaffoldType = "tool" | "provider" | "feature";

export function buildScaffoldTsconfig(type: PluginScaffoldType) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      declaration: type === "tool",
      rootDir: "src",
      outDir: "dist",
      skipLibCheck: true,
    },
    include: type === "feature" ? ["src/**/*.ts"] : ["src/index.ts"],
  };
}
