import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSettingIds } from "../../scripts/check-control-ui-setting-ids.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PAGE = "ui/src/pages/search/search-page.tsx";
const list = {
  pages: [
    { path: "/settings/search", settings: { "tools.web.search.provider": {}, "providers.*": {} } },
  ],
  aliases: { "search.provider": "tools.web.search.provider" },
};

function fixture(page: string, files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-setting-ids-");
  const all = {
    [PAGE]: page,
    "config/control-ui-setting-ids.txt": "providers.*\ntools.web.search.provider\n",
    ...files,
  };
  for (const [file, source] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, env: createNestedGitEnv() });
  return root;
}

const NAMED = `export const Page = () => (
  <>
    <SettingsRow setting="tools.web.search.provider" title="Provider" />
    <For each={providers}>{(id) => <li class="provider-row" id={\`providers.\${id}\`} />}</For>
    <SettingsRow info title="Status" />
    <div class="settings-row" data-settings-info />
  </>
);
`;

describe("check-control-ui-setting-ids", () => {
  it("accepts rows that name a listed setting or say they are not one", () => {
    expect(checkSettingIds(fixture(NAMED), { list })).toEqual([]);
  });

  it("rejects a Settings row that says nothing", () => {
    const failures = checkSettingIds(
      fixture(
        NAMED.replace(`<SettingsRow info title="Status" />`, `<SettingsRow title="Status" />`),
      ),
      { list },
    );
    expect(failures).toEqual([
      expect.stringContaining(`${PAGE}:5: <SettingsRow> has no setting ID`),
    ]);
  });

  it("rejects unlisted, repeated and undrawn IDs", () => {
    const failures = checkSettingIds(
      fixture(
        NAMED.replace(`setting="tools.web.search.provider"`, `setting="tools.web.search.typo"`),
      ),
      { list },
    );
    expect(failures).toEqual([
      expect.stringContaining("setting ID tools.web.search.typo is not listed"),
      expect.stringContaining(
        "Setting ID tools.web.search.provider is listed for /settings/search but no row draws it",
      ),
    ]);
    const twice = checkSettingIds(
      fixture(
        NAMED.replace(
          `<SettingsRow info title="Status" />`,
          `<SettingsRow setting="tools.web.search.provider" title="Again" />`,
        ),
      ),
      { list },
    );
    expect(twice).toEqual([
      expect.stringContaining("Setting ID tools.web.search.provider is drawn more than once"),
    ]);
  });

  it("keeps published IDs: removal needs an alias, new IDs need the list", () => {
    const removed = checkSettingIds(
      fixture(NAMED, {
        "config/control-ui-setting-ids.txt":
          "gone.setting\nproviders.*\ntools.web.search.provider\n",
      }),
      { list },
    );
    expect(removed).toEqual([expect.stringContaining("Setting ID gone.setting was removed")]);
    const aliased = checkSettingIds(
      fixture(NAMED, {
        "config/control-ui-setting-ids.txt":
          "providers.*\nsearch.provider\ntools.web.search.provider\n",
      }),
      { list },
    );
    expect(aliased).toEqual([]);
    const unpublished = checkSettingIds(
      fixture(NAMED, { "config/control-ui-setting-ids.txt": "providers.*\n" }),
      { list },
    );
    expect(unpublished).toEqual([expect.stringContaining("is missing new setting IDs")]);
  });

  it("lets listed files wait but only shrink", () => {
    const bare = NAMED.replace(
      `<SettingsRow info title="Status" />`,
      `<SettingsRow title="Status" />`,
    );
    expect(
      checkSettingIds(
        fixture(bare, { "config/control-ui-setting-ids-baseline.txt": `${PAGE}\n` }),
        { list },
      ),
    ).toEqual([]);
    expect(
      checkSettingIds(
        fixture(NAMED, { "config/control-ui-setting-ids-baseline.txt": `${PAGE}\n` }),
        { list },
      ),
    ).toEqual([expect.stringContaining(`${PAGE} names all its settings now`)]);
  });
});
