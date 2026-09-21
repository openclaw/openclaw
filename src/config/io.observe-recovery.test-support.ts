export const clobberedUpdateChannelConfig = { update: { channel: "beta" } };
export const clobberedUpdateChannelRaw = `${JSON.stringify(clobberedUpdateChannelConfig, null, 2)}\n`;
export const recoverableTelegramConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" },
  channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
};
export const recoverableCoreConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" as const },
};
export const largeRecoverableCoreConfig = {
  ...recoverableCoreConfig,
  gateway: {
    ...recoverableCoreConfig.gateway,
    trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
  },
};
