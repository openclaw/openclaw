import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import {
  configAt,
  migrateLegacyConfigForTest as migrate,
} from "./legacy-config-migrate.apply.test-support.js";

const supervision = {
  endpoints: [{ id: "local", transport: "stdio-proxy", command: "codex" }],
  allowRawTranscripts: true,
  allowWriteControls: true,
};

it.each([
  {
    name: "active supervision rewrites the allowlist",
    plugins: configAt({
      allow: ["telegram", "codex-supervisor", "codex"],
      "entries.codex-supervisor.enabled": true,
      "entries.codex-supervisor.config": supervision,
      "entries.codex-supervisor.hooks.enabled": true,
    }),
    expected: configAt({
      allow: ["telegram", "codex"],
      "entries.codex.enabled": true,
      "entries.codex.config.supervision": { enabled: true, ...supervision },
    }),
  },
  {
    name: "disabled supervision preserves the implicit harness",
    agents: { defaults: { model: "openai/gpt-5.5" } },
    plugins: configAt({
      "entries.codex.config.appServer": { transport: "stdio" },
      "entries.codex-supervisor.enabled": false,
    }),
    expected: configAt({
      "entries.codex.config": {
        appServer: { transport: "stdio" },
        supervision: { enabled: false },
      },
    }),
  },
  {
    name: "canonical values win while missing supervision fields are filled",
    plugins: configAt({
      deny: [" CODEX-SUPERVISOR ", "telegram"],
      "entries. CODEX .enabled": false,
      "entries. CODEX .config.appServer.transport": "stdio",
      "entries. CODEX .config.supervision.enabled": true,
      "entries. CODEX .config.supervision.endpoints": [
        { id: "canonical", transport: "stdio-proxy" },
      ],
      "entries. CODEX .config.supervision.allowWriteControls": false,
      "entries. CODEX-SUPERVISOR .enabled": true,
      "entries. CODEX-SUPERVISOR .config.endpoints": [{ id: "legacy", transport: "stdio-proxy" }],
      "entries. CODEX-SUPERVISOR .config.allowRawTranscripts": true,
      "entries. CODEX-SUPERVISOR .config.allowWriteControls": true,
    }),
    expected: configAt({
      deny: ["telegram"],
      "entries. CODEX .enabled": false,
      "entries. CODEX .config.appServer.transport": "stdio",
      "entries. CODEX .config.supervision.enabled": true,
      "entries. CODEX .config.supervision.endpoints": [
        { id: "canonical", transport: "stdio-proxy" },
      ],
      "entries. CODEX .config.supervision.allowRawTranscripts": true,
      "entries. CODEX .config.supervision.allowWriteControls": false,
    }),
  },
  {
    name: "denied legacy plugin leaves supervision dormant",
    plugins: {
      deny: ["codex-supervisor"],
      entries: { "codex-supervisor": { enabled: true, config: { allowWriteControls: true } } },
    },
    expected: {
      deny: [],
      entries: {
        codex: { config: { supervision: { enabled: false, allowWriteControls: true } } },
      },
    },
  },
  {
    name: "malformed legacy entry does not create Codex config",
    plugins: {
      entries: { "codex-supervisor": "invalid" },
    },
    expected: { entries: {} },
  },
])("migrates supervision: $name", ({ plugins, agents, expected }) => {
  const raw = {
    meta: { migrations: { skillWorkshopPlugin: true } },
    plugins,
    ...(agents ? { agents } : {}),
  };
  expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("plugins");
  const res = migrate(raw);
  expect(res.config?.plugins).toEqual(expected);
  if (agents) {
    expect(res.config?.agents).toEqual(agents);
  }
  expect(migrate(res.config)).toEqual({ config: null, changes: [] });
});
