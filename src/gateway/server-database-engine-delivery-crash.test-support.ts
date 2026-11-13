export function createDeliveryCrashPreload({
  window,
  id,
  serverUrl,
  observe = false,
  offset = 0,
}: {
  window: "receipt-before-ack" | "acceptance-before-receipt" | "response-lost";
  id: string;
  serverUrl: string;
  observe?: boolean;
  offset?: number;
}) {
  const identity = JSON.stringify(id);
  const receiptCommitted = window === "receipt-before-ack";
  let matches: string;
  if (observe) {
    matches = receiptCommitted
      ? `command?.type === "deliveryQueue.ack" && input?.id === ${identity}`
      : `command?.type === "deliveryQueue.finalizeFailure" &&
         JSON.parse(input.entry.entryJson).id === ${identity}`;
  } else if (window === "acceptance-before-receipt") {
    matches = `command?.type === "session.actor.deliverySettled" &&
      input?.settlement?.deliveryId === ${identity} && input.settlement.state === "delivered"`;
  } else if (window === "response-lost") {
    matches = `command?.type === "deliveryQueue.mutateOutbound" &&
      input?.id === ${identity} && input.kind === "fail"`;
  } else {
    matches = `command?.type === "deliveryQueue.ack" && input?.id === ${identity}`;
  }
  // Hold receipt/ACK requests before execution, or the committed transport-failure reply.
  // Restart observes real terminal replies with one clock across Gateway threads.
  return `data:text/javascript,${encodeURIComponent(`
    import threads, { Worker, isMainThread } from "node:worker_threads";
    import { syncBuiltinESMExports } from "node:module";
    import { deserialize } from "node:v8";
    const now = Date.now.bind(Date);
    Date.now = () => now() + ${offset};
    threads.Worker = class extends Worker {
      constructor(url, options = {}) {
        super(url, { ...options, execArgv: [
          ...(options.execArgv ?? process.execArgv), "--import", import.meta.url,
        ] });
      }
    };
    syncBuiltinESMExports();
    if (isMainThread) {
      const post = Worker.prototype.postMessage;
      const emit = Worker.prototype.emit;
      let target;
      const report = () => fetch(${JSON.stringify(`${serverUrl}/${observe ? "recovered" : "held"}`)}, {
        method: "POST", body: JSON.stringify({ id: ${identity}, pid: process.pid })
      }).then((response) => { if (!response.ok) throw new Error("Boundary report failed"); });
      Worker.prototype.postMessage = function(request, ...rest) {
        if (request?.type === "execute") {
          const command = deserialize(request.input);
          const input = command?.input;
          if (${matches}) {
            ${
              observe || window === "response-lost"
                ? "target = { worker: this, requestId: request.id };"
                : "void report(); return;"
            }
          }
        }
        return Reflect.apply(post, this, [request, ...rest]);
      };
      Worker.prototype.emit = function(event, ...args) {
        const reply = args[0];
        if (target?.worker === this && event === "message" &&
            reply?.id === target.requestId && reply.ok === true
            ${observe && !receiptCommitted ? "&& reply.value instanceof Uint8Array && deserialize(reply.value) === true" : ""}) {
          target = undefined;
          void report();
          ${!observe && window === "response-lost" ? "return true;" : ""}
        }
        return Reflect.apply(emit, this, [event, ...args]);
      };
    }
  `)}`;
}
