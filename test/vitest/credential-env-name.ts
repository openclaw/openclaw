const uppercaseEnvName = /^[A-Z][A-Z0-9_]*$/u;
const credentialSegment =
  /(?:^|_)(?:KEYS?|APIKEY|TOKENS?|SECRETS?|PASSWORD|PASSWD|CREDENTIALS?|AUTHORIZATION|COOKIE)(?:_|$)|AUTH_JSON$/u;

export function isCredentialEnvName(name: string): boolean {
  return uppercaseEnvName.test(name) && credentialSegment.test(name);
}
