import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest } from "./mock-gateway-page.test-support.ts";

type Row = Record<string, unknown>;
type Frame = { type: string; id: string; ok: boolean; payload: Row; error?: Row; event?: string };
type Controls = {
  emit: (event: string, payload: unknown) => void;
  deferNext: (method: string) => void;
  resolveDeferred: (method: string, payload?: unknown) => void;
  rejectDeferred: (method: string) => void;
  setMethodResponse: (method: string, payload: unknown) => void;
  setSessionsListResponse: (payload: { sessions: unknown[] }) => void;
};

export const sessionGatewayTest = mockGatewayTest.extend<{
  connect: (scenario?: ControlUiMockGatewayScenario) => Promise<{
    send: (method: string, params?: Row) => Promise<string>;
    response: (id: string) => Frame | undefined;
    request: (method: string, params?: Row) => Promise<Frame>;
    controls: Controls;
    frames: Frame[];
  }>;
}>({
  connect: async ({ gatewayPage }, use) => {
    await use(async (scenario = {}) => {
      const { window, execute } = gatewayPage;
      execute(createControlUiMockGatewayInitScript(scenario));
      const socket = new window.WebSocket("ws://mock-gateway");
      const frames: Frame[] = [];
      socket.addEventListener("message", (event: MessageEvent) => {
        frames.push(JSON.parse(String(event.data)) as Frame);
      });
      await flushMockTimers();
      let sequence = 0;
      const send = async (method: string, params: Row = {}) => {
        const id = String(++sequence);
        socket.send(JSON.stringify({ type: "req", id, method, params }));
        await flushMockTimers();
        return id;
      };
      const response = (id: string) =>
        frames.find((frame) => frame.type === "res" && frame.id === id);
      const controls = (
        window as typeof window & {
          openclawControlUiE2eGateway: Controls;
        }
      ).openclawControlUiE2eGateway;
      return {
        send,
        response,
        controls,
        frames,
        request: async (method, params) => {
          const frame = response(await send(method, params));
          if (!frame) {
            throw new Error(`Missing response for ${method}`);
          }
          return frame;
        },
      };
    });
  },
});
