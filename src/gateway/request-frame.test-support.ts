export const gatewayRequest = <P>(id: string, method: string, params: P) => ({
  type: "req" as const,
  id,
  method,
  params,
});
