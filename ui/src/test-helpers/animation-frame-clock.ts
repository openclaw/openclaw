export function createFrameClock() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    frames,
    request: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancel: (frame: number) => frames.delete(frame),
    flush: (timestamp: number) => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(timestamp));
    },
  };
}
