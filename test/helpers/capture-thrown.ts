export function captureThrown(run: () => unknown, message: string): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error(message);
}
