import {
  DEFAULT_CONTROL_UI_PROFILE,
  isControlUiProfile,
  type ControlUiProfile,
} from "./control-ui-profile.ts";

export type UiBrand = {
  productName: string;
  wordmark: string;
  dashboardName: string;
  logoMark: string;
  exportPrefix: string;
  docs: {
    home: string;
    dashboardAuth: string;
    tailscale: string;
    insecureHttp: string;
  };
};

const BRANDS: Record<ControlUiProfile, UiBrand> = {
  openclaw: {
    productName: "OpenClaw",
    wordmark: "OPENCLAW",
    dashboardName: "Gateway Dashboard",
    logoMark: "\\|/",
    exportPrefix: "openclaw",
    docs: {
      home: "https://docs.openclaw.ai",
      dashboardAuth: "https://docs.openclaw.ai/web/dashboard",
      tailscale: "https://docs.openclaw.ai/gateway/tailscale",
      insecureHttp: "https://docs.openclaw.ai/web/control-ui#insecure-http",
    },
  },
  americanclaw: {
    productName: "AmericanClaw",
    wordmark: "AMERICANCLAW",
    dashboardName: "Gateway Dashboard",
    logoMark: "\\|/",
    exportPrefix: "americanclaw",
    docs: {
      home: "https://docs.openclaw.ai",
      dashboardAuth: "https://docs.openclaw.ai/web/dashboard",
      tailscale: "https://docs.openclaw.ai/gateway/tailscale",
      insecureHttp: "https://docs.openclaw.ai/web/control-ui#insecure-http",
    },
  },
  elsehelp: {
    productName: "ElseHelp",
    wordmark: "ELSEHELP",
    dashboardName: "Gateway Dashboard",
    logoMark: "\\|/",
    exportPrefix: "elsehelp",
    docs: {
      home: "https://docs.openclaw.ai",
      dashboardAuth: "https://docs.openclaw.ai/web/dashboard",
      tailscale: "https://docs.openclaw.ai/gateway/tailscale",
      insecureHttp: "https://docs.openclaw.ai/web/control-ui#insecure-http",
    },
  },
};

export function resolveControlUiProfile(value: unknown): ControlUiProfile {
  if (isControlUiProfile(value)) {
    return value;
  }
  return DEFAULT_CONTROL_UI_PROFILE;
}

export function resolveUiBrand(value: unknown): UiBrand {
  return BRANDS[resolveControlUiProfile(value)];
}
