import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import { MACOS_APP_INSTALL_OWNER_MARKER } from "./test-runtime-config-helpers.js";

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: vi.fn(),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
async function write(relative: string, content = "") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}
const manifest = (value: unknown) => write("package.json", JSON.stringify(value));
const inspect = () => noteSourceInstallIssues(root);
function warning() {
  expect(note).toHaveBeenCalledOnce();
  return String(vi.mocked(note).mock.calls[0]?.[0]);
}
beforeEach(async () => {
  vi.mocked(note).mockReset();
  root = dirs.make("doctor-install-");
  await write("src/entry.ts", "export {};\n");
  await write("node_modules/.bin/tsx");
  await fs.mkdir(path.join(root, "node_modules/.pnpm"), { recursive: true });
  await manifest({ name: "openclaw" });
  await write("pnpm-workspace.yaml", "packages: ['.']\n");
});

it("reports the host owner instead of source package repair advice", async () => {
  await write("pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
  await write("openclaw-install-owner.json", MACOS_APP_INSTALL_OWNER_MARKER);
  await inspect();
  expect(note).toHaveBeenCalledExactlyOnceWith(
    "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    "Install",
  );
});

it("warns when source dependencies were not installed by pnpm", async () => {
  await fs.rmdir(path.join(root, "node_modules/.pnpm"));
  await fs.unlink(path.join(root, "node_modules/.bin/tsx"));
  await inspect();
  expect(warning()).toEqual(
    [
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
      "- tsx binary is missing for source runs. Run: pnpm install.",
    ].join("\n"),
  );
});

it.each([
  ["block map", "overrides:\n  openclaw: 'link:'\n", true],
  ["alias", "pins: &pins {openclaw: 'link:.'}\noverrides: *pins\n", true],
  ["nested value", "overrides:\n  example:\n    openclaw: 'link:.'\n", false],
  ["non-string", "overrides:\n  openclaw: [link]\n", false],
  ["normal override", "overrides:\n  openclaw: 2026.9.4\n", false],
  ["malformed YAML", "overrides: [\n", false],
  ["duplicate key", "overrides:\n  openclaw: 'link:.'\n  openclaw: 2026.9.4\n", false],
  [
    "excessive aliases",
    "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\noverrides: {openclaw: 'link:.'}\n",
    false,
  ],
] as const)("checks workspace self-links in %s", async (_name, workspace, selfLink) => {
  await write("pnpm-workspace.yaml", workspace);
  await inspect();
  if (selfLink) {
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("pnpm-workspace.yaml contains a self-referential"),
      "Install",
    );
  } else {
    expect(note).not.toHaveBeenCalled();
  }
});

it.each(["dependencies", "devDependencies"])(
  "reports %s with selective repair guidance",
  async (section) => {
    await manifest({ [section]: { openclaw: "link:." } });
    await inspect();
    const message = warning();
    for (const text of [
      "package.json has a self-referential",
      "git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml",
      "missing override pins",
      "preserving unrelated edits in all three files",
      "pnpm install --frozen-lockfile",
    ]) {
      expect(message).toContain(text);
    }
  },
);

it.each([
  ["unreadable workspace", "package-lock.json present"],
  ["malformed manifest", "pnpm-workspace.yaml contains"],
])("continues other checks after %s", async (failure, expected) => {
  await write("pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
  if (failure === "unreadable workspace") {
    await fs.unlink(path.join(root, "pnpm-workspace.yaml"));
    await fs.mkdir(path.join(root, "pnpm-workspace.yaml"));
    await write("package-lock.json", "{}");
  } else {
    await write("package.json", "{");
  }
  await inspect();
  expect(warning()).toContain(expected);
});

it("ignores healthy manifests, absent roots, and packaged lookalikes", async () => {
  await noteSourceInstallIssues(null);
  await manifest({ dependencies: { openclaw: "^2026.9.4" }, devDependencies: { openclaw: null } });
  await inspect();
  await fs.unlink(path.join(root, "src/entry.ts"));
  await write("pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
  await manifest({ dependencies: { openclaw: "link:." } });
  await inspect();
  expect(note).not.toHaveBeenCalled();
});

it("preserves legitimate non-self local links", async () => {
  const link = "link:../openclaw-fork";
  await write("pnpm-workspace.yaml", `overrides: {openclaw: '${link}'}\n`);
  await manifest({ dependencies: { openclaw: link }, devDependencies: { openclaw: link } });
  await inspect();
  expect(note).not.toHaveBeenCalled();
});

it.each(["absolute", "symlink"])(
  "detects a %s self-link without claiming a lockfile error",
  async (kind) => {
    if (kind === "symlink") {
      await fs.symlink(
        root,
        path.join(root, "self"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const link = `link:${kind === "absolute" ? root : "self"}`;
    await write("pnpm-workspace.yaml", `overrides: {openclaw: '${link}'}\n`);
    await manifest({ dependencies: { openclaw: link } });
    await inspect();
    const message = warning();
    for (const text of [
      "package.json has a self-referential",
      "pnpm-workspace.yaml contains a self-referential",
      "can break frozen pnpm installs",
      "If the link is unintended",
    ]) {
      expect(message).toContain(text);
    }
    expect(message).not.toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
  },
);
