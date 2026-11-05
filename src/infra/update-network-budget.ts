// Metadata has no reliable size estimate; downloads use this as an inactivity
// watchdog so slow transfers can keep making progress without a total deadline.
export const UPDATE_NETWORK_TIMEOUT_MS = 300_000;
