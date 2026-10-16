import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveStatePortRoots } from "./state-port.js";

const stateDir = path.resolve("/synthetic/selected");
const home = path.resolve("/synthetic/home");
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_STATE_DIR: "/unselected",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};

it.each<{
  label: string;
  config: OpenClawConfig;
  roots: string[];
}>([
  { label: "selected and retained default", config: {}, roots: [] },
  {
    label: "disabled custom store",
    config: {
      plugins: { entries: { "voice-call": { enabled: false, config: { store: "~/calls" } } } },
    },
    roots: [path.join(home, "calls")],
  },
  {
    label: "both configured package aliases",
    config: {
      plugins: {
        enabled: false,
        entries: {
          "voice-call": { config: { store: path.join(home, "first") } },
          "@openclaw/voice-call": { config: { store: path.join(home, "second") } },
        },
      },
    },
    roots: [path.join(home, "first"), path.join(home, "second")],
  },
  {
    label: "duplicate custom store and excluded Matrix account roots",
    config: {
      plugins: {
        entries: {
          "voice-call": { config: { store: path.join(stateDir, "voice-calls") } },
        },
      },
      channels: {
        matrix: {
          homeserver: "https://matrix.example.test",
          accounts: {
            main: { userId: "@main:example.test" },
            retained: { enabled: false, userId: "@retained:example.test" },
          },
        },
      },
    },
    roots: [],
  },
])("discovers $label with the optional plugin absent", ({ config, roots }) => {
  expect(resolveStatePortRoots({ config, stateDir, env })).toEqual(
    [stateDir, path.join(stateDir, "voice-calls"), ...roots].map((root) =>
      path.join(root, "state", "openclaw.sqlite"),
    ),
  );
});
