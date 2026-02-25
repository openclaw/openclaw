Feature: Gateway config token fallback on env/config drift

  Background:
    Given gateway mode is local
    And the local gateway port is 18789

  Scenario: env token double-mismatch falls back to config token
    Given OPENCLAW_GATEWAY_TOKEN is set to "env-token"
    And gateway.auth.token in config is "config-token"
    When callGateway is called
    And attempt 1 fails with device token mismatch (env-token + stored device)
    And attempt 2 fails with device token mismatch (env-token + no stored device)
    Then attempt 3 uses config-token with no stored device token
    And the call succeeds

  Scenario: env and config tokens identical — no third attempt
    Given OPENCLAW_GATEWAY_TOKEN is set to "same-token"
    And gateway.auth.token in config is "same-token"
    When callGateway is called
    And attempt 1 fails with device token mismatch
    And attempt 2 fails with device token mismatch
    Then only 2 attempts are made
    And the mismatch error propagates

  Scenario: config token missing — no third attempt
    Given OPENCLAW_GATEWAY_TOKEN is set to "env-token"
    And gateway.auth.token is not set in config
    When callGateway is called
    And attempt 1 fails with device token mismatch
    And attempt 2 fails with device token mismatch
    Then only 2 attempts are made
    And the mismatch error propagates

  Scenario: remote mode — no config fallback
    Given gateway mode is remote with a configured remote URL
    And the remote has a token set
    When callGateway is called
    And attempt 1 fails with device token mismatch
    And attempt 2 fails with device token mismatch
    Then only 2 attempts are made
    And the mismatch error propagates

  Scenario: second attempt fails with non-mismatch error — no third attempt
    Given OPENCLAW_GATEWAY_TOKEN is set to "env-token"
    And gateway.auth.token in config is "config-token"
    When callGateway is called
    And attempt 1 fails with device token mismatch
    And attempt 2 fails with a non-mismatch error
    Then only 2 attempts are made
    And the non-mismatch error propagates
