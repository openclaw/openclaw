"""Tests for WebSocket protocol utilities."""

import json

import pytest

from openclaw_py.gateway.ws_protocol import (
    create_error_response,
    create_event,
    create_response,
    parse_frame,
    serialize_frame,
    validate_request,
)
from openclaw_py.gateway.ws_types import (
    WebSocketError,
    WebSocketEvent,
    WebSocketFrame,
    WebSocketRequest,
)


def test_parse_frame_valid_request():
    """Test parsing valid request frame."""
    raw = '{"type":"request","id":"1","method":"ping","params":{}}'
    frame = parse_frame(raw)

    assert frame is not None
    assert frame.type == "request"
    assert frame.id == "1"
    assert frame.method == "ping"


def test_parse_frame_valid_response():
    """Test parsing valid response frame."""
    raw = '{"type":"response","id":"1","result":{"status":"ok"}}'
    frame = parse_frame(raw)

    assert frame is not None
    assert frame.type == "response"
    assert frame.id == "1"
    assert frame.result == {"status": "ok"}


def test_parse_frame_valid_event():
    """Test parsing valid event frame."""
    raw = '{"type":"event","event":"test","params":{"foo":"bar"}}'
    frame = parse_frame(raw)

    assert frame is not None
    assert frame.type == "event"
    assert frame.event == "test"
    assert frame.params == {"foo": "bar"}


def test_parse_frame_invalid_json():
    """Test parsing invalid JSON returns None."""
    raw = '{"type":"request",invalid json}'
    frame = parse_frame(raw)

    assert frame is None


def test_parse_frame_empty_string():
    """Test parsing empty string returns None."""
    frame = parse_frame("")

    assert frame is None


def test_parse_frame_missing_type():
    """Test parsing frame with missing required field."""
    raw = '{"id":"1","method":"ping"}'
    frame = parse_frame(raw)

    # Should fail validation and return None
    assert frame is None


def test_create_response_success():
    """Test creating success response."""
    response_json = create_response("req-1", result={"pong": True})
    data = json.loads(response_json)

    assert data["type"] == "response"
    assert data["id"] == "req-1"
    assert data["result"] == {"pong": True}
    assert "error" not in data


def test_create_response_with_error():
    """Test creating error response."""
    error = WebSocketError(code="not_found", message="Not found")
    response_json = create_response("req-1", error=error)
    data = json.loads(response_json)

    assert data["type"] == "response"
    assert data["id"] == "req-1"
    assert data["error"]["code"] == "not_found"
    assert data["error"]["message"] == "Not found"
    assert "result" not in data


def test_create_error_response():
    """Test creating error response helper."""
    response_json = create_error_response(
        "req-1",
        "unauthorized",
        "Not authenticated",
    )
    data = json.loads(response_json)

    assert data["type"] == "response"
    assert data["id"] == "req-1"
    assert data["error"]["code"] == "unauthorized"
    assert data["error"]["message"] == "Not authenticated"


def test_create_error_response_with_details():
    """Test creating error response with details."""
    response_json = create_error_response(
        "req-1",
        "invalid_params",
        "Invalid parameters",
        details={"field": "email", "issue": "required"},
    )
    data = json.loads(response_json)

    assert data["error"]["code"] == "invalid_params"
    assert data["error"]["details"]["field"] == "email"


def test_create_event():
    """Test creating event frame."""
    event_json = create_event("session.created", {"session_id": "123"})
    data = json.loads(event_json)

    assert data["type"] == "event"
    assert data["event"] == "session.created"
    assert data["params"]["session_id"] == "123"


def test_create_event_no_params():
    """Test creating event without params."""
    event_json = create_event("server.shutdown")
    data = json.loads(event_json)

    assert data["type"] == "event"
    assert data["event"] == "server.shutdown"
    assert data["params"] == {}


def test_validate_request_valid():
    """Test validating valid request frame."""
    frame = WebSocketFrame(
        type="request",
        id="1",
        method="ping",
        params={},
    )
    request = validate_request(frame)

    assert request is not None
    assert request.id == "1"
    assert request.method == "ping"


def test_validate_request_not_request_type():
    """Test validating non-request frame returns None."""
    frame = WebSocketFrame(
        type="response",
        id="1",
        result={},
    )
    request = validate_request(frame)

    assert request is None


def test_validate_request_missing_id():
    """Test validating request without ID returns None."""
    frame = WebSocketFrame(
        type="request",
        method="ping",
    )
    request = validate_request(frame)

    assert request is None


def test_validate_request_missing_method():
    """Test validating request without method returns None."""
    frame = WebSocketFrame(
        type="request",
        id="1",
    )
    request = validate_request(frame)

    assert request is None


def test_serialize_frame_request():
    """Test serializing request frame."""
    request = WebSocketRequest(
        id="1",
        method="get_status",
        params={"verbose": True},
    )
    json_str = serialize_frame(request)
    data = json.loads(json_str)

    assert data["type"] == "request"
    assert data["id"] == "1"
    assert data["method"] == "get_status"
    assert data["params"]["verbose"] is True


def test_serialize_frame_event():
    """Test serializing event frame."""
    event = WebSocketEvent(
        event="test.event",
        params={"key": "value"},
    )
    json_str = serialize_frame(event)
    data = json.loads(json_str)

    assert data["type"] == "event"
    assert data["event"] == "test.event"
    assert data["params"]["key"] == "value"


def test_roundtrip_parse_and_serialize():
    """Test parsing and serializing maintains data integrity."""
    original = WebSocketRequest(
        id="roundtrip-1",
        method="test_method",
        params={"data": [1, 2, 3]},
    )

    # Serialize and parse
    json_str = serialize_frame(original)
    frame = parse_frame(json_str)

    assert frame is not None
    assert frame.type == "request"
    assert frame.id == "roundtrip-1"
    assert frame.method == "test_method"
    assert frame.params == {"data": [1, 2, 3]}
