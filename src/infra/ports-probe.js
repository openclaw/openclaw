import net from "node:net";
export async function tryListenOnPort(params) {
    const listenOptions = { port: params.port };
    if (params.host) {
        listenOptions.host = params.host;
    }
    if (typeof params.exclusive === "boolean") {
        listenOptions.exclusive = params.exclusive;
    }
    await new Promise((resolve, reject) => {
        const tester = net
            .createServer()
            .once("error", (err) => reject(err))
            .once("listening", () => {
            tester.close(() => resolve());
        })
            .listen(listenOptions);
    });
}
