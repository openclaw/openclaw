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

const PLUGIN_VIEW = "extensions/whatsapp/browser/settings.tsx";
const PLUGIN_MANIFEST = JSON.stringify({
  id: "whatsapp",
  channels: ["whatsapp"],
  controlUi: {
    entry: "dist/control-ui/index.js",
    activation: "settings-only",
    settingsViews: [
      {
        section: "channels",
        panel: "detail",
        channelId: "whatsapp",
        settings: { "plugin.whatsapp.linkedPhone": { label: "Linked phone" } },
      },
    ],
  },
});
const PLUGIN_ROWS = `export const View = () => (
  <>
    <div class="settings-row" id="plugin.whatsapp.linkedPhone" />
    <div class="settings-row" data-settings-info />
  </>
);
`;

function pluginFixture(view: string) {
  return fixture(NAMED, {
    [PLUGIN_VIEW]: view,
    "extensions/whatsapp/openclaw.plugin.json": PLUGIN_MANIFEST,
    "config/control-ui-setting-ids.txt":
      "plugin.whatsapp.linkedPhone\nproviders.*\ntools.web.search.provider\n",
  });
}

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

  it("sees a row component imported under another name", () => {
    const aliased = `import { SettingsRow as Row } from "../../components/solid/settings-ui.tsx";\n${NAMED.replace(
      `<SettingsRow info title="Status" />`,
      `<Row title="Status" />`,
    )}`;
    expect(checkSettingIds(fixture(aliased), { list })).toEqual([
      expect.stringContaining("<SettingsRow> has no setting ID"),
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
  it("holds plugin Settings views to the IDs their manifest declares", () => {
    expect(checkSettingIds(pluginFixture(PLUGIN_ROWS), { list })).toEqual([]);
    const undeclared = checkSettingIds(
      pluginFixture(PLUGIN_ROWS.replace(`data-settings-info`, `id="plugin.whatsapp.undeclared"`)),
      { list },
    );
    expect(undeclared).toEqual([
      expect.stringContaining(
        "setting ID plugin.whatsapp.undeclared is not declared in extensions/whatsapp/openclaw.plugin.json",
      ),
    ]);
    const undrawn = checkSettingIds(
      pluginFixture(PLUGIN_ROWS.replace(`id="plugin.whatsapp.linkedPhone"`, `data-settings-info`)),
      { list },
    );
    expect(undrawn).toEqual([
      expect.stringContaining(
        "Setting ID plugin.whatsapp.linkedPhone is declared in extensions/whatsapp/openclaw.plugin.json controlUi.settingsViews[].settings but no row draws it",
      ),
    ]);
    const bare = checkSettingIds(pluginFixture(PLUGIN_ROWS.replace(` data-settings-info`, "")), {
      list,
    });
    expect(bare).toEqual([expect.stringContaining(`${PLUGIN_VIEW}:4: <div> has no setting ID`)]);
  });
});
