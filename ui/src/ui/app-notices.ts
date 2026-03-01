export type AppNotice = {
  kind: "info" | "success" | "danger";
  message: string;
};

type NoticeHost = {
  controlUiNotice: AppNotice | null;
  controlUiNoticeTimer: number | null;
};

export function showTransientNotice(host: NoticeHost, notice: AppNotice, durationMs = 4500) {
  if (host.controlUiNoticeTimer !== null) {
    window.clearTimeout(host.controlUiNoticeTimer);
    host.controlUiNoticeTimer = null;
  }
  host.controlUiNotice = notice;
  host.controlUiNoticeTimer = window.setTimeout(() => {
    host.controlUiNotice = null;
    host.controlUiNoticeTimer = null;
  }, durationMs);
}

export function dismissTransientNotice(host: NoticeHost) {
  if (host.controlUiNoticeTimer !== null) {
    window.clearTimeout(host.controlUiNoticeTimer);
    host.controlUiNoticeTimer = null;
  }
  host.controlUiNotice = null;
}
