export async function getCurrentTime() {
  return { currentTime: new Date().toISOString() };
}
export async function handleMessage(message: string) {
  if (message.toLowerCase().includes("time")) {
    return await getCurrentTime();
  }
  return { response: "I could not understand the request." };
}
