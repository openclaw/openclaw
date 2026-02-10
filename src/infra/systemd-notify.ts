import dgram from "node:dgram";
import fs from "node:fs";

/**
 * Sends a notification to systemd via the NOTIFY_SOCKET.
 * @param state The state string to send (e.g., 'READY=1', 'WATCHDOG=1')
 */
export function sendNotification(state: string): void {
  const socketPath = process.env.NOTIFY_SOCKET;
  if (!socketPath) {
    return;
  }

  // Handle abstract namespace sockets (starting with @)
  const isAbstract = socketPath.startsWith("@");
  const buffer = Buffer.from(state + "\n");

  try {
    const client = dgram.createSocket("unix_dgram");

    // Abstract sockets need to be prefixed with \0
    const finalPath = isAbstract ? "\0" + socketPath.slice(1) : socketPath;

    client.send(buffer, 0, buffer.length, finalPath, (err) => {
      client.close();
      if (err) {
        // We don't want to crash the process if notification fails
        console.error("[systemd-notify] Failed to send notification:", err);
      }
    });
  } catch (err) {
    console.error("[systemd-notify] Error creating socket or sending notification:", err);
  }
}

/**
 * Notify systemd that the service is ready.
 */
export function notifyReady(): void {
  sendNotification("READY=1");
}

/**
 * Notify systemd watchdog to reset the timer.
 */
export function notifyWatchdog(): void {
  sendNotification("WATCHDOG=1");
}
