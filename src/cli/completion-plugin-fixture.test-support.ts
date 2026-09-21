import fs from "node:fs/promises";
import path from "node:path";

export async function writeCompletionPluginFixture(root: string) {
  const pluginDir = path.join(root, "plugin");
  const configPath = path.join(root, "openclaw.json");
  const marker = path.join(root, "action.json");
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "completion-options-fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "completion-options-fixture", configSchema: { type: "object" } }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `import fs from "node:fs";
export default function register(api) {
  api.registerCli(({ program }) => {
    for (const kind of ["required", "optional"]) {
      const parent = program.command("proof-" + kind)
        .option(kind === "required" ? "-m, --mode <value>" : "-m, --mode [value]");
      const group = parent.command("group").alias("g").option("--mode");
      const show = group.command("show").option("--json");
      show.addOption(show.createOption("--hidden").hideHelp());
      show.action((options) => fs.writeFileSync(${JSON.stringify(marker)},
        JSON.stringify({ parent: parent.opts(), group: group.opts(), options })));
      const pick = group.command("pick");
      pick.addOption(pick.createOption("--mode <value>").choices(["local", "other"]));
      pick.option("--json");
    }
  }, { descriptors: ["required", "optional"].map(kind => ({
    name: "proof-" + kind, description: "Completion option contract", hasSubcommands: true,
  })) });
}`,
  );
  await fs.writeFile(
    configPath,
    JSON.stringify({
      logging: { file: path.join(root, "cli.log"), level: "silent", consoleLevel: "silent" },
      plugins: {
        allow: ["completion-options-fixture"],
        load: { paths: [pluginDir] },
        slots: { memory: "none" },
        entries: { "completion-options-fixture": { enabled: true } },
      },
    }),
  );
  return {
    marker,
    env: {
      PATH: process.env.PATH,
      ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      NO_COLOR: "1",
    },
  };
}
