import { expect, vi } from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

export function expectCall(mock: TestMock, args: unknown[], mode?: "once" | "last") {
  if (mode === "once") {
    expect(mock).toHaveBeenCalledExactlyOnceWith(...args);
  } else if (mode === "last") {
    expect(mock).toHaveBeenLastCalledWith(...args);
  } else {
    expect(mock).toHaveBeenCalledWith(...args);
  }
}

export function expectUnused(...mocks: TestMock[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export function textMessage(text: string, role = "assistant") {
  return { role, content: [{ type: "text", text }] };
}

export function clearMocks(...mocks: TestMock[]) {
  for (const mock of mocks) {
    mock.mockClear();
  }
}
