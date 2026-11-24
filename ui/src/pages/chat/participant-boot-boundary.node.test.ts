// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { expect, it } from "vitest";
import { controlUiSolidPlugin } from "../../../config/control-ui-solid.ts";

it("keeps optional participant presentation and copy behind Chat and Home lazy boundaries", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const entries = {
    chat: path.join(root, "pages/chat/chat-view.tsx"),
    composer: path.join(root, "pages/chat/components/chat-composer-regions.tsx"),
    copy: path.join(root, "i18n/locales/en-chat-composer.ts"),
    home: path.join(root, "components/home-session-unavailable.tsx"),
    mobile: path.join(root, "pages/chat/components/chat-pane-mobile-composition.tsx"),
    sharing: path.join(root, "pages/chat/components/chat-session-sharing.solid.tsx"),
  };
  const deferred = [
    "pages/chat/session-approval-notice.tsx",
    "pages/chat/components/chat-invite-access.tsx",
    "pages/chat/components/chat-guest-welcome-status.tsx",
    "pages/chat/components/chat-mobile-people.tsx",
    "pages/chat/components/chat-session-sharing-options.tsx",
    "pages/chat/components/chat-session-sharing-content.tsx",
    "pages/chat/components/chat-session-sharing-mobile-adapter.ts",
    "pages/chat/components/chat-session-sharing-modes.tsx",
    "i18n/locales/en-approvals.ts",
    "i18n/locales/en-chat-session-sharing.ts",
  ].map((file) => path.join(root, file));
  const owners = new Set([
    ...Object.values(entries),
    ...deferred,
    path.join(root, "pages/chat/chat-view-notices.tsx"),
    path.join(root, "pages/chat/components/chat-guest-welcome.tsx"),
    path.join(root, "pages/chat/components/chat-session-sharing-shared.tsx"),
  ]);
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      ...controlUiSolidPlugin(),
      {
        name: "participant-boot-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          // Retain the changed participant rendering/copy edges and their real UI ingress.
          if (importer && !owners.has(path.resolve(path.dirname(importer), source))) {
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
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) {
      return;
    }
    reachable.add(file);
    chunks.find((chunk) => chunk.fileName === file)?.imports.forEach(visit);
  };
  for (const name of Object.keys(entries)) {
    const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === name);
    expect(entry).toBeDefined();
    visit(entry!.fileName);
  }
  const hot = chunks.filter((chunk) => reachable.has(chunk.fileName));
  const hotModules = hot.flatMap((chunk) => Object.keys(chunk.modules));
  const coldModules = chunks
    .filter((chunk) => !reachable.has(chunk.fileName))
    .flatMap((chunk) => Object.keys(chunk.modules));
  expect(hotModules).toEqual(expect.arrayContaining(Object.values(entries).map(normalizePath)));
  for (const module of deferred.map(normalizePath)) {
    expect(hotModules).not.toContain(module);
    expect(coldModules).toContain(module);
  }
  const hotCode = hot.map((chunk) => chunk.code).join("\n");
  const allCode = chunks.map((chunk) => chunk.code).join("\n");
  for (const copy of [
    "Waiting for the session creator’s approval.",
    "Invite {name}",
    "chat.sessionSharing.sharedDescription",
  ]) {
    expect(hotCode).not.toContain(copy);
    expect(allCode).toContain(copy);
  }
});
