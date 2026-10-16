import { expect, type Mock } from "vitest";

export function expectCall(mock: Mock, args: unknown[], mode?: "once" | "last") {
  if (mode === "once") {
    expect(mock).toHaveBeenCalledExactlyOnceWith(...args);
  } else if (mode === "last") {
    expect(mock).toHaveBeenLastCalledWith(...args);
  } else {
    expect(mock).toHaveBeenCalledWith(...args);
  }
}

export function expectUnused(...mocks: Mock[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export function textMessage(text: string, role = "assistant") {
  return { role, content: [{ type: "text", text }] };
}

export function clearMocks(...mocks: Mock[]) {
  for (const mock of mocks) {
    mock.mockClear();
  }
}
