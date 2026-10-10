export type WeixinQrState = {
  phase: "idle" | "starting" | "waiting" | "verification" | "expired" | "connected" | "error";
  qrDataUrl: string | null;
  sessionKey: string | null;
  expiresAtMs: number | null;
  message: string | null;
  busy: boolean;
};

export function initialWeixinQrState(): WeixinQrState {
  return {
    phase: "idle",
    qrDataUrl: null,
    sessionKey: null,
    expiresAtMs: null,
    message: null,
    busy: false,
  };
}
