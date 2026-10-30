// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { expect, it } from "vitest";
import { controlUiSolidPlugin } from "../../config/control-ui-solid.ts";

it("keeps composer conflict recovery outside the durable transcript entry", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entries = {
    transcript: path.join(root, "pages/chat/components/chat-message-bubble-view.tsx"),
    notices: path.join(root, "pages/chat/chat-view-notices-content.tsx"),
  };
  const owners = new Set([
    ...Object.values(entries),
    path.join(root, "pages/chat/components/chat-workspace-conflict.tsx"),
    path.join(root, "pages/chat/workspace-conflict.ts"),
    path.join(root, "i18n/locales/en-chat-session.ts"),
    path.join(root, "i18n/locales/en-chat-session-optional.ts"),
    path.resolve(root, "../../src/shared/shell-quote.ts"),
    path.resolve(root, "../../packages/terminal-core/src/safe-text.ts"),
  ]);
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      ...controlUiSolidPlugin(),
      {
        name: "workspace-conflict-boot-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          const resolved = importer && path.resolve(path.dirname(importer), source);
          // Keep both real entries and the complete conflict/copy catalog boundary.
          // Unrelated shell, rendering, and Gateway owners do not affect this split.
          if (resolved && !owners.has(resolved) && !owners.has(resolved.replace(/\.js$/, ".ts"))) {
            return { id: source, external: true };
          }
          return null;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: { input: entries, preserveEntrySignatures: "strict" },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected one in-memory build");
  }
  const chunks = result.output.filter((asset) => asset.type === "chunk");
  const closure = (name: string, exported: string) => {
    const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === name);
    expect(entry?.exports).toContain(exported);
    if (!entry) {
      throw new Error(`Missing ${name} entry`);
    }
    const reachable = new Set<string>();
    const visit = (file: string) => {
      if (reachable.has(file)) {
        return;
      }
      reachable.add(file);
      chunks.find((chunk) => chunk.fileName === file)?.imports.forEach(visit);
    };
    visit(entry.fileName);
    const selected = chunks.filter((chunk) => reachable.has(chunk.fileName));
    return {
      code: selected.map((chunk) => chunk.code).join("\n"),
      modules: selected.flatMap((chunk) =>
        Object.entries(chunk.modules)
          .filter(([, module]) => module.renderedLength > 0)
          .map(([id]) => id),
      ),
    };
  };
  const hot = closure("transcript", "GroupedMessage");
  const cold = closure("notices", "ChatComposerNoticesContent");
  expect(hot.modules).toContain(normalizePath(entries.transcript));
  expect(hot.code).toContain("chat-workspace-conflict-event");
  expect(hot.code).toContain("Local versions were kept for these paths");
  for (const marker of [
    "chat-workspace-conflict-notice",
    "git show ",
    "Local versions kept; inspect or take the cloud version.",
  ]) {
    expect(hot.code).not.toContain(marker);
    expect(cold.code).toContain(marker);
  }
  expect(cold.modules).toContain(normalizePath(entries.notices));
});
