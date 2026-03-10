import { describe, expect, it } from "vitest";
import {
  buildAllowlistView,
  buildSettingSubmenu,
  buildSettingsMainMenu,
  normalizeStreamingDisplay,
  parseSettingsCallbackData,
  SETTING_VALUES,
} from "./settings-buttons.js";

describe("parseSettingsCallbackData", () => {
  it("returns null for non-settings data", () => {
    expect(parseSettingsCallbackData("mdl_prov")).toBeNull();
    expect(parseSettingsCallbackData("")).toBeNull();
    expect(parseSettingsCallbackData("random_data")).toBeNull();
  });

  it("parses cfg_menu", () => {
    expect(parseSettingsCallbackData("cfg_menu")).toEqual({ type: "menu" });
  });

  it("parses cfg_menu with whitespace", () => {
    expect(parseSettingsCallbackData("  cfg_menu  ")).toEqual({ type: "menu" });
  });

  it("parses submenu callbacks", () => {
    expect(parseSettingsCallbackData("cfg_s_dmpol")).toEqual({
      type: "submenu",
      setting: "dmpol",
    });
    expect(parseSettingsCallbackData("cfg_s_grppol")).toEqual({
      type: "submenu",
      setting: "grppol",
    });
    expect(parseSettingsCallbackData("cfg_s_stream")).toEqual({
      type: "submenu",
      setting: "stream",
    });
  });

  it("parses allowlist submenu callback", () => {
    expect(parseSettingsCallbackData("cfg_s_allow")).toEqual({
      type: "submenu",
      setting: "allow",
    });
  });

  it("returns null for invalid submenu setting", () => {
    expect(parseSettingsCallbackData("cfg_s_invalid")).toBeNull();
    expect(parseSettingsCallbackData("cfg_s_")).toBeNull();
  });

  it("parses set-value callbacks", () => {
    expect(parseSettingsCallbackData("cfg_v_dmpol_open")).toEqual({
      type: "set",
      setting: "dmpol",
      value: "open",
    });
    expect(parseSettingsCallbackData("cfg_v_grppol_disabled")).toEqual({
      type: "set",
      setting: "grppol",
      value: "disabled",
    });
    expect(parseSettingsCallbackData("cfg_v_stream_block")).toEqual({
      type: "set",
      setting: "stream",
      value: "block",
    });
  });

  it("returns null for invalid set-value combinations", () => {
    // Invalid setting key
    expect(parseSettingsCallbackData("cfg_v_invalid_open")).toBeNull();
    // Invalid value for setting
    expect(parseSettingsCallbackData("cfg_v_dmpol_block")).toBeNull();
    expect(parseSettingsCallbackData("cfg_v_grppol_pairing")).toBeNull();
    expect(parseSettingsCallbackData("cfg_v_stream_pairing")).toBeNull();
  });

  it("returns null for partial cfg_ prefixes", () => {
    expect(parseSettingsCallbackData("cfg_")).toBeNull();
    expect(parseSettingsCallbackData("cfg_x")).toBeNull();
    expect(parseSettingsCallbackData("cfg_v_")).toBeNull();
  });
});

describe("callback data byte lengths", () => {
  it("all callback data strings are under 64 bytes", () => {
    const allCallbackData = [
      "cfg_menu",
      "cfg_s_dmpol",
      "cfg_s_grppol",
      "cfg_s_stream",
      "cfg_s_allow",
    ];
    for (const setting of ["dmpol", "grppol", "stream"] as const) {
      for (const value of SETTING_VALUES[setting]) {
        allCallbackData.push(`cfg_v_${setting}_${value}`);
      }
    }
    for (const data of allCallbackData) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("buildSettingsMainMenu", () => {
  it("renders current values in text", () => {
    const result = buildSettingsMainMenu({
      dmPolicy: "pairing",
      groupPolicy: "open",
      streaming: "partial",
    });
    expect(result.text).toContain("DM Policy: pairing");
    expect(result.text).toContain("Group Policy: open");
    expect(result.text).toContain("Streaming: partial");
  });

  it("uses defaults for undefined values", () => {
    const result = buildSettingsMainMenu({});
    expect(result.text).toContain("DM Policy: pairing");
    expect(result.text).toContain("Group Policy: open");
    expect(result.text).toContain("Streaming: partial");
  });

  it("normalizes streaming boolean to display value", () => {
    const result = buildSettingsMainMenu({ streaming: "false" });
    // "false" as string is not a valid streaming mode, falls to default
    expect(result.text).toContain("Streaming: partial");
  });

  it("has 2 rows of 2 buttons each", () => {
    const result = buildSettingsMainMenu({});
    expect(result.buttons).toHaveLength(2);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[1]).toHaveLength(2);
  });

  it("buttons have correct callback data", () => {
    const result = buildSettingsMainMenu({});
    const allData = result.buttons.flat().map((b) => b.callback_data);
    expect(allData).toContain("cfg_s_dmpol");
    expect(allData).toContain("cfg_s_grppol");
    expect(allData).toContain("cfg_s_stream");
    expect(allData).toContain("cfg_s_allow");
  });
});

describe("buildSettingSubmenu", () => {
  it("shows checkmark on current value", () => {
    const result = buildSettingSubmenu("dmpol", "pairing");
    expect(result.text).toContain("pairing \u2713");
    expect(result.text).not.toContain("open \u2713");

    // Button also has checkmark
    const pairingBtn = result.buttons.flat().find((b) => b.callback_data === "cfg_v_dmpol_pairing");
    expect(pairingBtn?.text).toContain("\u2713");
  });

  it("includes back button", () => {
    const result = buildSettingSubmenu("grppol", "open");
    const lastRow = result.buttons[result.buttons.length - 1];
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0].callback_data).toBe("cfg_menu");
    expect(lastRow[0].text).toBe("<< Back");
  });

  it("has one button per value plus back", () => {
    for (const setting of ["dmpol", "grppol", "stream"] as const) {
      const result = buildSettingSubmenu(setting, undefined);
      // Each value gets its own row + 1 back row
      expect(result.buttons).toHaveLength(SETTING_VALUES[setting].length + 1);
    }
  });

  it("normalizes streaming display for checkmark", () => {
    const result = buildSettingSubmenu("stream", "progress");
    // "progress" maps to "partial", so partial should have checkmark
    expect(result.text).toContain("partial \u2713");
  });
});

describe("buildAllowlistView", () => {
  it("shows empty allowlists", () => {
    const result = buildAllowlistView([], []);
    expect(result.text).toContain("DM allowlist:");
    expect(result.text).toContain("(none)");
    expect(result.text).toContain("Group allowlist:");
    expect(result.text).toContain("Use /allowlist");
  });

  it("shows entries", () => {
    const result = buildAllowlistView(["123", "@user"], ["456"]);
    expect(result.text).toContain("  123");
    expect(result.text).toContain("  @user");
    expect(result.text).toContain("  456");
  });

  it("truncates long lists", () => {
    const entries = Array.from({ length: 15 }, (_, i) => String(i));
    const result = buildAllowlistView(entries, []);
    expect(result.text).toContain("...and 5 more");
    // First 10 should be present
    expect(result.text).toContain("  0");
    expect(result.text).toContain("  9");
  });

  it("has back button", () => {
    const result = buildAllowlistView([], []);
    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0][0].callback_data).toBe("cfg_menu");
  });
});

describe("normalizeStreamingDisplay", () => {
  it("maps boolean true to partial", () => {
    expect(normalizeStreamingDisplay(true)).toBe("partial");
  });

  it("maps boolean false to off", () => {
    expect(normalizeStreamingDisplay(false)).toBe("off");
  });

  it("maps progress to partial", () => {
    expect(normalizeStreamingDisplay("progress")).toBe("partial");
  });

  it("passes through valid string values", () => {
    expect(normalizeStreamingDisplay("off")).toBe("off");
    expect(normalizeStreamingDisplay("partial")).toBe("partial");
    expect(normalizeStreamingDisplay("block")).toBe("block");
  });

  it("defaults undefined to partial", () => {
    expect(normalizeStreamingDisplay(undefined)).toBe("partial");
  });
});
