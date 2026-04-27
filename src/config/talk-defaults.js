export const TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM = {
    macos: 700,
    android: 700,
    ios: 900,
};
export function describeTalkSilenceTimeoutDefaults() {
    const macos = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.macos;
    const ios = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.ios;
    return `${macos} ms on macOS and Android, ${ios} ms on iOS`;
}
