"""Tests for WebSocket types and models."""

import pytest
from pydantic import ValidationError

from openclaw_py.gateway.ws_types import (
    ConnectParams,
    WebSocketClient,
    WebSocketError,
    WebSocketEvent,
    WebSocketFrame,
    WebSocketRequest,
    WebSocketResponse,
)


def test_connect_params_minimal():
    """Test ConnectParams with minimal fields."""
    params = ConnectParams()
    assert params.protocol_version == "1.0"
    assert params.client_id is None


def test_connect_params_full():
    """Test ConnectParams with all fields."""
    params = ConnectParams(
        client_id="test-client",
        client_version="1.2.3",
        protocol_version="2.0",
        device_id="device-123",
        platform="ios",
    )
    assert params.client_id == "test-client"
    assert params.client_version == "1.2.3"
    assert params.protocol_version == "2.0"
    assert params.device_id == "device-123"
    assert params.platform == "ios"


def test_websocket_client_creation():
    """Test WebSocketClient model creation."""
    client = WebSocketClient(
        conn_id="conn-123",
        client_id="client-456",
        client_version="1.0.0",
        connected_at=1700000000,
    )
    assert client.conn_id == "conn-123"
    assert client.client_id == "client-456"
    assert client.authenticated is False
    assert client.auth_source is None


def test_websocket_frame_request():
    """Test WebSocketFrame for request type."""
    frame = WebSocketFrame(
        type="request",
        id="1",
        method="ping",
        params={"foo": "bar"},
    )
    assert frame.type == "request"
    assert frame.id == "1"
    assert frame.method == "ping"
    assert frame.params == {"foo": "bar"}


def test_websocket_frame_response():
    """Test WebSocketFrame for response type."""
    frame = WebSocketFrame(
        type="response",
        id="1",
        result={"status": "ok"},
    )
    assert frame.type == "response"
    assert frame.id == "1"
    assert frame.result == {"status": "ok"}
    assert frame.error is None


def test_websocket_frame_error_response():
    """Test WebSocketFrame for error response."""
    frame = WebSocketFrame(
        type="response",
        id="1",
        error={"code": "not_found", "message": "Resource not found"},
    )
    assert frame.type == "response"
    assert frame.id == "1"
    assert frame.result is None
    assert frame.error["code"] == "not_found"


def test_websocket_frame_event():
    """Test WebSocketFrame for event type."""
    frame = WebSocketFrame(
        type="event",
        event="session.created",
        params={"session_id": "123"},
    )
    assert frame.type == "event"
    assert frame.event == "session.created"
    assert frame.params == {"session_id": "123"}


def test_websocket_request_model():
    """Test WebSocketRequest model."""
    request = WebSocketRequest(
        id="req-1",
        method="get_status",
        params={"verbose": True},
    )
    assert request.type == "request"
    assert request.id == "req-1"
    assert request.method == "get_status"
    assert request.params == {"verbose": True}


def test_websocket_request_default_params():
    """Test WebSocketRequest with default params."""
    request = WebSocketRequest(id="req-1", method="ping")
    assert request.params == {}


def test_websocket_response_success():
    """Test WebSocketResponse with success result."""
    response = WebSocketResponse(
        id="req-1",
        result={"pong": True},
    )
    assert response.type == "response"
    assert response.id == "req-1"
    assert response.result == {"pong": True}
    assert response.error is None


def test_websocket_response_error():
    """Test WebSocketResponse with error."""
    response = WebSocketResponse(
        id="req-1",
        error={"code": "unauthorized", "message": "Not authenticated"},
    )
    assert response.type == "response"
    assert response.id == "req-1"
    assert response.result is None
    assert response.error["code"] == "unauthorized"


def test_websocket_event_model():
    """Test WebSocketEvent model."""
    event = WebSocketEvent(
        event="config.updated",
        params={"version": 2},
    )
    assert event.type == "event"
    assert event.event == "config.updated"
    assert event.params == {"version": 2}


def test_websocket_error_model():
    """Test WebSocketError model."""
    error = WebSocketError(
        code="invalid_method",
        message="Method not found",
        details={"method": "unknown"},
    )
    assert error.code == "invalid_method"
    assert error.message == "Method not found"
    assert error.details == {"method": "unknown"}


def test_websocket_error_no_details():
    """Test WebSocketError without details."""
    error = WebSocketError(
        code="server_error",
        message="Internal server error",
    )
    assert error.code == "server_error"
    assert error.message == "Internal server error"
    assert error.details is None


def test_frame_serialization():
    """Test WebSocketFrame JSON serialization."""
    frame = WebSocketRequest(
        id="1",
        method="ping",
        params={},
    )
    json_str = frame.model_dump_json(exclude_none=True)
    assert "request" in json_str
    assert "ping" in json_str
    assert "id" in json_str


def test_frame_deserialization():
    """Test WebSocketFrame JSON deserialization."""
    json_data = {
        "type": "request",
        "id": "1",
        "method": "ping",
        "params": {},
    }
    frame = WebSocketFrame(**json_data)
    assert frame.type == "request"
    assert frame.id == "1"
    assert frame.method == "ping"
