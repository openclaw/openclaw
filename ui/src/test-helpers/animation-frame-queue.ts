export function createFrameQueue() {
  const frames: FrameRequestCallback[] = [];
  return {
    frames,
    request: (callback: FrameRequestCallback) => frames.push(callback),
  };
}
