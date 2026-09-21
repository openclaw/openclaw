export function createInboundBody<T extends string>(body: T) {
  return { Body: body, RawBody: body, CommandBody: body };
}

export function createSessionBody<T extends string>(body: T) {
  return { Body: body, BodyStripped: body };
}

export function createProviderSurface<T extends string>(provider: T) {
  return { Provider: provider, Surface: provider };
}

export function createInboundTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createInboundBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

export function createSessionTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createSessionBody(body), ...createProviderSurface(provider), ChatType: chatType };
}
