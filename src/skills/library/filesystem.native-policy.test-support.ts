import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { prepareSkillLibraryBundle, readSkillLibraryManifestTree } from "./bundle.js";

const directory = process.argv[2]!;
const bundle = prepareSkillLibraryBundle([
  {
    path: "SKILL.md",
    content: "---\nname: guide\ndescription: Synthetic guide\n---\nSynthetic instructions\n",
  },
]);
for (const file of bundle.files) {
  await fs.writeFile(path.join(directory, file.path), file.bytes);
}
const manifest = JSON.stringify(bundle.files.map(({ bytes: _bytes, ...file }) => file));
try {
  for (const mode of ["require", "off", "require"] as const) {
    configureFsSafeNative({ mode });
    const pending = readSkillLibraryManifestTree(directory, manifest, bundle.revision);
    configureFsSafeNative({ mode: "off" });
    const available = await pending.then(
      () => true,
      () => false,
    );
    assert.equal(available, mode === "off", `manifest native ${mode}`);
  }
} finally {
  await closeSkillsWatchers();
}
