import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasMissingSkillDependencies,
  hasOperatorReadAccess,
  setTabFromRoute,
} from "./app-settings.ts";
import type { Tab } from "./navigation.ts";

type SettingsHost = Parameters<typeof setTabFromRoute>[0] & {
  logsPollInterval: number | null;
  debugPollInterval: number | null;
};

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    navWidth: 220,
  },
  theme: "claw",
  themeMode: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  logsPollInterval: null,
  debugPollInterval: null,
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });
});

describe("hasOperatorReadAccess", () => {
  it("accepts operator.read/operator.write/operator.admin as read-capable", () => {
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.read"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.write"] })).toBe(true);
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.admin"] })).toBe(true);
  });

  it("returns false when read-compatible scope is missing", () => {
    expect(hasOperatorReadAccess({ role: "operator", scopes: ["operator.pairing"] })).toBe(false);
    expect(hasOperatorReadAccess({ role: "operator" })).toBe(false);
    expect(hasOperatorReadAccess(null)).toBe(false);
  });
});

describe("hasMissingSkillDependencies", () => {
  it("returns false when all requirement buckets are empty", () => {
    expect(
      hasMissingSkillDependencies({
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      }),
    ).toBe(false);
  });

  it("returns true when any requirement bucket has entries", () => {
    expect(
      hasMissingSkillDependencies({
        bins: ["op"],
        anyBins: [],
        env: [],
        config: [],
        os: [],
      }),
    ).toBe(true);

    expect(
      hasMissingSkillDependencies({
        bins: [],
        anyBins: ["op", "gopass"],
        env: [],
        config: [],
        os: [],
      }),
    ).toBe(true);
  });
});
