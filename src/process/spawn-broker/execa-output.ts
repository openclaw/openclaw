import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";

/** Execa retains its reader; the Gateway receives a separate native output socket. */
export async function createExecaOutput(): Promise<{ receiver: Socket; transform: Transform }> {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-spawn-"));
  const server = createServer({ pauseOnConnect: true });
  let writer: Socket | undefined;
  let receiver: Socket | undefined;
  try {
    const socketPath = path.join(directory, "out");
    server.listen(socketPath);
    await once(server, "listening");
    const accepted = new Promise<Socket>((resolve) => {
      server.once("connection", resolve);
    });
    receiver = createConnection(socketPath);
    [writer] = await Promise.all([accepted, once(receiver, "connect")]);
    const destination = writer;
    const transform = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        // The callback gates execa's reader too, unlike a second .pipe() consumer.
        destination.write(chunk, (error) => callback(error, chunk));
      },
      flush(callback: TransformCallback) {
        destination.end(callback);
      },
      destroy(error, callback) {
        destination.destroy();
        callback(error);
      },
    });
    destination.on("error", (error) => transform.destroy(error));
    destination.once("close", () => {
      if (!destination.writableFinished) {
        transform.destroy();
      }
    });
    return { receiver, transform };
  } catch (error) {
    writer?.destroy();
    receiver?.destroy();
    throw error;
  } finally {
    server.close();
    // Connected sockets retain their endpoints after the private rendezvous is removed.
    await rm(directory, { recursive: true, force: true });
  }
}
