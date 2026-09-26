import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { attachGatewaySchemaFenceDelegate, withStateSchemaFence } = await import(
  workerData.coordinatorUrl
);
const delegate = await attachGatewaySchemaFenceDelegate(workerData.port, workerData.params);

parentPort.on("message", (message) => {
  if (message === "close") {
    delegate.close();
    parentPort.close();
    return;
  }
  try {
    const operation = () => withStateSchemaFence(workerData.params, () => "schema admitted");
    const result = message === "delegated" ? delegate.run(operation) : operation();
    parentPort.postMessage({ result }, []);
  } catch (error) {
    parentPort.postMessage({ error: error.name }, []);
  }
});
parentPort.postMessage("ready", []);
