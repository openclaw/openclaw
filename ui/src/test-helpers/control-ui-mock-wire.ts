export type ControlUiMockRequestFrame = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  type?: unknown;
};

// Serialized into the mock browser transport without module dependencies.
export function parseControlUiMockRequestFrame(
  raw: string | ArrayBufferLike | Blob | ArrayBufferView,
): ControlUiMockRequestFrame | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ControlUiMockRequestFrame;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
