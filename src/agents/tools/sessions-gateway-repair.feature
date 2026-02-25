Feature: Gateway repair pairing auto-approval for session tools

  Background:
    Given the gateway is running in local loopback mode
    And the local device ID is "test-device-id"

  Scenario: successful call passes through unchanged
    When callGatewayWithRepairApproval is called
    And the underlying callGateway succeeds
    Then the result is returned directly
    And no pairing repair is attempted

  Scenario: non-pairing error passes through unchanged
    When callGatewayWithRepairApproval is called
    And callGateway throws a non-pairing error
    Then the original error is rethrown
    And no pairing repair is attempted

  Scenario: pairing required auto-approved on loopback with valid repair request
    Given a pending repair request exists for this device with role "operator" created 10s ago
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required" on the first attempt
    Then the pending request is approved
    And callGateway is retried
    And the retry result is returned

  Scenario: pairing required but no repair candidate found
    Given no pending repair requests exist
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then GatewayRepairError is thrown with a hint
    And approveDevicePairing is not called

  Scenario: pairing required in remote mode — no auto-repair
    Given the gateway is in remote mode
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then the original pairing error is rethrown
    And no pairing repair is attempted

  Scenario: retry after approval also fails
    Given a pending repair request exists for this device with role "operator" created 10s ago
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required" on the first attempt
    And callGateway throws an error on the retry attempt
    Then the retry error propagates

  Scenario: stale pending request older than 120s is not auto-approved
    Given a pending repair request exists for this device created 200s ago
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then GatewayRepairError is thrown
    And approveDevicePairing is not called

  Scenario: pending request with wrong deviceId is not auto-approved
    Given a pending repair request exists for a different device
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then GatewayRepairError is thrown
    And approveDevicePairing is not called

  Scenario: pending request with non-operator role is not auto-approved
    Given a pending repair request exists with role "viewer"
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then GatewayRepairError is thrown
    And approveDevicePairing is not called

  Scenario: pending request with isRepair=false is not auto-approved
    Given a pending repair request exists with isRepair set to false
    When callGatewayWithRepairApproval is called
    And callGateway throws "pairing required"
    Then GatewayRepairError is thrown
    And approveDevicePairing is not called
